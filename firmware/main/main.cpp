// Claude Pokemon Buddy firmware - Milestone B5
//
// Builds on B4's ES8311 audio with host-driven sounds: the host sends a PLAY
// frame (type 0x03, payload[0] = sound id) so it can chime the buddy on its own
// events, and sends CONFIG (type 0x04, payload[0] = sound id) to set the local
// KEY-press cry. Three system sounds plus 18 species cries are synthesized on
// boot; PLAY selects a sound immediately while KEY plays the active cry.
// The codec's I2C control bus is shared with the SHTC3 (same SDA13/SCL14)
// via codec_board (see codec_init.c _i2c_init reuse).
//
// B3 added the device -> host uplink: periodic SHTC3 room temp/humidity (SENSOR
// frames) and KEY/BOOT button events (BUTTON frames). Wire format matches host
// (host/src/transport/proto.js + serial.js):
//
//   frame = [0xA5][type][seq][len_lo][len_hi][payload...][crc32 LE]
//           crc32 covers header+payload (first 5+len bytes), poly 0xEDB88320.
//   FRAME  0x01 (in)  = [x u16][y u16][w u16][h u16][RLE bytes]   -> blit
//   PLAY   0x03 (in)  = [sound_id]                                -> play now
//   CONFIG 0x04 (in)  = [sound_id]                                -> set KEY cry
//   VOLUME 0x25 (in)  = [volume 0..100]                            -> set codec volume
//   HELLO  0x81 (out) = [proto_ver][sound_count]                   -> boot handshake
//   ACK    0x84 (out) = [acked_seq]                               (host matches seq)
//   NACK   0x85 (out) = [rejected_seq]                            (semantic FRAME reject)
//   SENSOR 0x83 (out) = [temp i16 LE, units 0.1C][humidity u8 %]  (seq ignored by host)
//   BUTTON 0x82 (out) = [key_id][kind_id]   key 1=KEY/2=BOOT, kind 1=short/2=long/3=double
//
// Uplink frames are fire-and-forget: the host emits events on them without
// ACKing, so we never wait. All USB-Serial-JTAG writes go through send_frame()
// under tx_mutex so concurrent ACK / SENSOR / BUTTON frames never interleave.

#include <assert.h>
#include <math.h>
#include <string.h>

#include <atomic>

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <driver/gpio.h>
#include <esp_timer.h>
#include <esp_log.h>
#include <esp_heap_caps.h>
#include "driver/usb_serial_jtag.h"

#include <lwip/sockets.h>
#include <lwip/netdb.h>
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "nvs_flash.h"
#include "mdns.h"

#include "display_bsp.h"
#include "shtc3.h"
#include "multi_button.h"
#include "codec_bsp.h"

static const char *TAG = "buddy-b5";

// ---- Panel + sensor (constructed during C++ static init, on the main task) -
static constexpr int W = 400;
static constexpr int H = 300;
static DisplayPort RlcdPort(12, 11, 5, 40, 41, W, H);

static constexpr int I2C_SCL = 14;
static constexpr int I2C_SDA = 13;
// I2C + SHTC3 are built in app_main, NOT during C++ static init: the new-style
// i2c_master driver allocates an interrupt, which isn't reliably available when
// global constructors run, so constructing here boot-loops the device. (The SPI
// panel above happens to tolerate static-init construction; I2C does not.)
static I2cMasterBus *g_bus = nullptr;
static Shtc3 *g_sensor = nullptr;

// ---- Buttons ---------------------------------------------------------------
static constexpr int KEY_GPIO  = 18;   // board "KEY"  -> host key_id 1
static constexpr int BOOT_GPIO = 0;    // board "BOOT" -> host key_id 2
static constexpr uint8_t KEY_ID_KEY  = 1;
static constexpr uint8_t KEY_ID_BOOT = 2;
static constexpr uint8_t KIND_SHORT  = 1;
static constexpr uint8_t KIND_LONG   = 2;
static constexpr uint8_t KIND_DOUBLE = 3;

// ---- Protocol --------------------------------------------------------------
static constexpr uint8_t MAGIC    = 0xA5;
static constexpr uint8_t PROTO_VER = 1;
static constexpr uint8_t T_FRAME  = 0x01;
static constexpr uint8_t T_PLAY   = 0x03;   // host -> device: play sound, payload[0]=id
static constexpr uint8_t T_CONFIG = 0x04;   // host -> device: set active KEY cry
static constexpr uint8_t T_VOLUME = 0x25;   // host -> device: set codec volume 0..100
static constexpr uint8_t T_HELLO  = 0x81;
static constexpr uint8_t T_BUTTON = 0x82;
static constexpr uint8_t T_SENSOR = 0x83;
static constexpr uint8_t T_ACK    = 0x84;
static constexpr uint8_t T_NACK   = 0x85;
static constexpr uint8_t T_AUTH   = 0x86;   // host -> device (wifi only): pre-shared pairing token

static constexpr size_t RX_MAX   = 48 * 1024;     // > largest valid frame (~30KB)
static constexpr size_t RECT_MAX = (W * H) / 8;   // 15000B = full-screen 1bpp
static constexpr size_t MAX_INBOUND_PAYLOAD = 30016; // RLE worst-case (~2x) + rect header slack
static_assert(MAX_INBOUND_PAYLOAD == 2 * RECT_MAX + 16, "host protocol constants must match firmware payload limit");
static constexpr uint32_t SENSOR_PERIOD_MS = 30000;

static uint8_t *rxbuf = nullptr;                  // frame accumulation (PSRAM)
static size_t   rxlen = 0;
static uint8_t *rectbuf = nullptr;                // RLE-decoded rect (PSRAM)

// ---- WiFi (Phase 2: bring-up + reachability probe only, no frame protocol
// wired to it yet -- that's Phase 3). Credentials are hardcoded per the
// project's "flash-time config" approach; edit before flashing for your own
// networks. Device joins as a STA client (not an AP) so it lands on the same
// LAN as whichever computer is running the host, and advertises itself via
// mDNS (_cpb._tcp.local) so the host doesn't need a fixed IP.
struct WifiCred { const char *ssid; const char *pass; };
static const WifiCred WIFI_CREDS[] = {
    { "CHANGE_ME_HOME_SSID", "CHANGE_ME_HOME_PASSWORD" },
    { "CHANGE_ME_WORK_SSID", "CHANGE_ME_WORK_PASSWORD" },
};
static constexpr int WIFI_CRED_COUNT = sizeof(WIFI_CREDS) / sizeof(WIFI_CREDS[0]);
static constexpr uint32_t WIFI_RETRY_CYCLE_DELAY_MS = 5000; // pause after a full pass over all creds fails
static constexpr uint16_t WIFI_TCP_PORT = 7311;
// Must match host/config.json's wifi.token (host/config.json is gitignored --
// this literal is the only place this specific value has to be copied to).
static const char *WIFI_PAIRING_TOKEN = "3f8f358c348ddcc0c6695ab2bf5fae6d";
static std::atomic<int> g_wifi_cred_idx{0};
static bool g_mdns_started = false;

static SemaphoreHandle_t tx_mutex = nullptr;      // serializes USJ writes
static QueueHandle_t     btn_queue = nullptr;     // button events -> button_task
static std::atomic<uint32_t> g_tx_drop_count{0};
static bool have_last_acked_frame_seq = false;
static uint8_t last_acked_frame_seq = 0;

// ---- Audio (ES8311; built in app_main like the I2C sensor) -----------------
static constexpr int AUDIO_SR = 16000;            // sample rate (Hz)
static constexpr int AUDIO_CH = 2;                // stereo frames (L=R into mono spk)
// Sound ids carried in PLAY/CONFIG payload[0].
static constexpr uint8_t SND_BUI    = 0;          // idle cry (KEY press)
static constexpr uint8_t SND_EVOLVE = 1;          // evolution fanfare (host PLAY)
static constexpr uint8_t SND_HOUR   = 2;          // top-of-hour chime (host PLAY)
// One note: sweep f0 -> f1 over `ms`. f0 == 0 means a silent gap.
struct Note { float f0, f1; int ms; };
#include "species_cries.inc"
static constexpr uint8_t SND_COUNT = 21;           // 3 system sounds + 18 species cries
static_assert(SND_SPECIES_BASE == 3, "species ids must start after BUI/EVOLVE/HOUR");
static_assert(SND_COUNT == SND_SPECIES_BASE + SND_SPECIES_COUNT, "sound count must match species_cries.inc");
static CodecPort    *g_codec = nullptr;
static int16_t      *g_snd[SND_COUNT] = {};       // synthesized PCM per sound (PSRAM)
static size_t        g_snd_bytes[SND_COUNT] = {};
static QueueHandle_t audio_queue = nullptr;       // sound id -> audio_task
static std::atomic<uint8_t> g_active_cry{SND_BUI};  // KEY-press cry; set by host CONFIG
static std::atomic<uint8_t> g_volume{80};
static void play_sound(uint8_t id);               // fwd decl (used by parse_frames)

static uint32_t crc32(const uint8_t *b, size_t n)
{
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++) {
        c ^= b[i];
        for (int k = 0; k < 8; k++)
            c = (c >> 1) ^ (0xEDB88320u & (0u - (c & 1u)));
    }
    return ~c;
}

// Build [MAGIC|type|seq|len(2)|payload|crc32] and write it atomically.
static bool send_frame(uint8_t type, uint8_t seq, const uint8_t *payload, uint8_t len)
{
    uint8_t f[5 + 64 + 4];
    if (len > 64) return false;
    f[0] = MAGIC; f[1] = type; f[2] = seq; f[3] = len; f[4] = 0;
    if (len) memcpy(f + 5, payload, len);
    uint32_t c = crc32(f, 5 + len);
    f[5 + len]     = c & 0xff;
    f[5 + len + 1] = (c >> 8) & 0xff;
    f[5 + len + 2] = (c >> 16) & 0xff;
    f[5 + len + 3] = (c >> 24) & 0xff;
    xSemaphoreTake(tx_mutex, portMAX_DELAY);
    const size_t total = 5 + (size_t)len + 4;
    int written = usb_serial_jtag_write_bytes(f, total, pdMS_TO_TICKS(100));
    xSemaphoreGive(tx_mutex);
    if (written != (int)total) {
        uint32_t drops = ++g_tx_drop_count;
        ESP_LOGW(TAG, "serial tx drop #%u type=0x%02x seq=%u wrote=%d/%u",
                 (unsigned)drops, type, seq, written, (unsigned)total);
        return false;
    }
    return true;
}

static void send_ack(uint8_t seq)
{
    send_frame(T_ACK, seq, &seq, 1);              // payload[0] = acked seq
}

static void send_nack(uint8_t seq)
{
    send_frame(T_NACK, seq, &seq, 1);             // payload[0] = rejected seq
}

static void send_hello(void)
{
    uint8_t p[2] = { PROTO_VER, SND_COUNT };
    send_frame(T_HELLO, 0, p, sizeof(p));
}

static void hello_task(void *)
{
    send_hello();
    vTaskDelay(pdMS_TO_TICKS(500));
    send_hello();
    vTaskDelete(nullptr);
}

static void set_volume(uint8_t vol)
{
    if (vol > 100) return;
    g_volume.store(vol);
    if (g_codec) g_codec->set_volume(vol);
}

// Decode a FRAME payload (dirty-rect header + RLE) and blit it. Returns true
// only when the payload is well-formed and fully applied.
static bool handle_frame_payload(const uint8_t *p, size_t len)
{
    if (len < 8) return false;
    uint16_t x = p[0] | (p[1] << 8);
    uint16_t y = p[2] | (p[3] << 8);
    uint16_t w = p[4] | (p[5] << 8);
    uint16_t h = p[6] | (p[7] << 8);
    if (w == 0 || h == 0 || (int)(x + w) > W || (int)(y + h) > H) return false;

    const size_t rectRowBytes = (w + 7) / 8;      // w is multiple of 8
    const size_t need = rectRowBytes * h;
    if (need > RECT_MAX) return false;

    size_t out = 0;
    for (size_t i = 8; i + 1 < len; i += 2) {
        uint8_t count = p[i];
        uint8_t value = p[i + 1];
        if (out + count > need) return false;     // overrun guard
        memset(rectbuf + out, value, count);
        out += count;
    }
    if (out != need) return false;                // size mismatch -> drop

    for (uint16_t row = 0; row < h; row++) {
        const uint8_t *r = rectbuf + (size_t)row * rectRowBytes;
        for (uint16_t col = 0; col < w; col++) {
            uint8_t bit = (r[col >> 3] >> (7 - (col & 7))) & 1;
            RlcdPort.RLCD_SetPixel(x + col, y + row, bit ? ColorBlack : ColorWhite);
        }
    }
    RlcdPort.RLCD_Display();                       // blocks until SPI transfer done
    return true;
}

static void parse_frames(void)
{
    size_t pos = 0;
    while (rxlen - pos >= 5) {
        if (rxbuf[pos] != MAGIC) { pos++; continue; }
        uint16_t len = rxbuf[pos + 3] | (rxbuf[pos + 4] << 8);
        if (len > MAX_INBOUND_PAYLOAD) { pos++; continue; }
        size_t frameLen = 5 + (size_t)len + 4;
        if (rxlen - pos < frameLen) break;
        const uint8_t *f = rxbuf + pos;
        uint32_t got = f[5 + len] | (f[5 + len + 1] << 8) |
                       (f[5 + len + 2] << 16) | ((uint32_t)f[5 + len + 3] << 24);
        if (crc32(f, 5 + len) == got) {
            if (f[1] == T_FRAME) {
                if (have_last_acked_frame_seq && f[2] == last_acked_frame_seq) {
                    send_ack(f[2]);                  // duplicate retry: ACK, do not re-blit
                } else if (handle_frame_payload(f + 5, len)) {
                    last_acked_frame_seq = f[2];
                    have_last_acked_frame_seq = true;
                    send_ack(f[2]);                  // ACK on success
                } else {
                    send_nack(f[2]);                 // semantic reject: bad rect/RLE shape
                }
            } else if (f[1] == T_PLAY && len >= 1) {
                play_sound(f[5]);                  // payload[0] = sound id; fire-and-forget (no ACK)
            } else if (f[1] == T_CONFIG && len >= 1) {
                if (f[5] < SND_COUNT) g_active_cry.store(f[5]); // 非法 id 拒绝, 不改值
            } else if (f[1] == T_VOLUME && len == 1) {
                set_volume(f[5]);                   // malformed/oor values are ignored
            }
            pos += frameLen;
        } else {
            pos++;                                 // bad CRC -> resync
        }
    }
    if (pos > 0) {
        memmove(rxbuf, rxbuf + pos, rxlen - pos);
        rxlen -= pos;
    }
}

static void rx_task(void *arg)
{
    uint8_t tmp[1024];
    for (;;) {
        int n = usb_serial_jtag_read_bytes(tmp, sizeof(tmp), pdMS_TO_TICKS(100));
        if (n <= 0) continue;
        if (rxlen + (size_t)n > RX_MAX) {
            parse_frames();                       // drain any complete frames before dropping
            if (rxlen + (size_t)n > RX_MAX) {
                rxlen = 0;                        // backlog is unparseable garbage -> last-resort resync
            }
        }
        memcpy(rxbuf + rxlen, tmp, n);
        rxlen += n;
        parse_frames();
    }
}

// Read SHTC3 every SENSOR_PERIOD_MS and uplink a SENSOR frame. First read runs
// immediately so the host's "room" field stops showing -- within a few seconds.
static void sensor_task(void *arg)
{
    for (;;) {
        float t, h;
        if (g_sensor->read(&t, &h)) {
            int16_t ti = (int16_t)lroundf(t * 10.0f);
            uint8_t p[3] = { (uint8_t)(ti & 0xff), (uint8_t)((ti >> 8) & 0xff),
                             (uint8_t)lroundf(h) };
            send_frame(T_SENSOR, 0, p, sizeof(p));
            ESP_LOGI(TAG, "sensor %.1fC %.0f%%", t, (double)h);
        } else {
            ESP_LOGW(TAG, "sensor read failed");
        }
        vTaskDelay(pdMS_TO_TICKS(SENSOR_PERIOD_MS));
    }
}

static void button_task(void *arg)
{
    uint16_t ev;                                   // (key_id << 8) | kind_id
    for (;;) {
        if (xQueueReceive(btn_queue, &ev, portMAX_DELAY) == pdTRUE) {
            uint8_t p[2] = { (uint8_t)(ev >> 8), (uint8_t)(ev & 0xff) };
            send_frame(T_BUTTON, 0, p, sizeof(p));
            ESP_LOGI(TAG, "button key=%u kind=%u", p[0], p[1]);
        }
    }
}

// Render a square-wave note sequence into a fresh 16-bit stereo (L=R) PSRAM
// buffer. Each note gets a 5ms attack + linear decay so the chiptune voice has
// shape without clicks. (Same synthesis as B4's chirp, now reused for all sounds.)
static void synth_tone(const Note *notes, int count, int16_t **out, size_t *bytes)
{
    int frames = 0;
    for (int j = 0; j < count; j++) frames += AUDIO_SR * notes[j].ms / 1000;
    *bytes = (size_t)frames * AUDIO_CH * sizeof(int16_t);
    *out = (int16_t *) heap_caps_malloc(*bytes, MALLOC_CAP_SPIRAM);
    if (*out == NULL) {
        ESP_LOGE(TAG, "synth_tone: PSRAM alloc of %zu bytes failed", *bytes);
        *bytes = 0;
        return;
    }

    int idx = 0;
    const int attack = AUDIO_SR * 5 / 1000;        // 5ms attack avoids a click
    for (int j = 0; j < count; j++) {
        const Note &nt = notes[j];
        int n = AUDIO_SR * nt.ms / 1000;
        float phase = 0.0f;
        for (int i = 0; i < n; i++) {
            int16_t v = 0;
            if (nt.f0 > 0.0f) {                    // f0==0 => silent gap
                float frac = (float)i / n;
                float freq = nt.f0 + (nt.f1 - nt.f0) * frac;  // linear sweep
                phase += freq / AUDIO_SR;
                if (phase >= 1.0f) phase -= 1.0f;
                float sq = (phase < 0.5f) ? 1.0f : -1.0f;     // square wave (chiptune)
                float env = (i < attack) ? (float)i / attack : (1.0f - 0.7f * frac);
                v = (int16_t)(sq * env * 8000.0f);
            }
            (*out)[idx++] = v;                     // L
            (*out)[idx++] = v;                     // R
        }
    }
}

// Synthesize all system voices and species cries once at boot. Bui = two rising
// syllables. Evolve = a rising C-major arpeggio landing on a held high C.
// Hour = two short A5 beeps (a discreet chime).
static void synth_all(void)
{
    static const Note BUI[]    = { {520.f, 780.f, 110}, {0.f, 0.f, 40}, {760.f, 1150.f, 130} };
    static const Note EVOLVE[] = { {523.f, 523.f, 90}, {659.f, 659.f, 90},
                                   {784.f, 784.f, 90}, {1047.f, 1047.f, 240} };
    static const Note HOUR[]   = { {880.f, 880.f, 90}, {0.f, 0.f, 70}, {880.f, 880.f, 90} };
    synth_tone(BUI,    3, &g_snd[SND_BUI],    &g_snd_bytes[SND_BUI]);
    synth_tone(EVOLVE, 4, &g_snd[SND_EVOLVE], &g_snd_bytes[SND_EVOLVE]);
    synth_tone(HOUR,   3, &g_snd[SND_HOUR],   &g_snd_bytes[SND_HOUR]);
    size_t free_before = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    for (int i = 0; i < SND_SPECIES_COUNT; i++)
        synth_tone(SPECIES_CRIES[i].notes, SPECIES_CRIES[i].count,
                   &g_snd[SND_SPECIES_BASE + i], &g_snd_bytes[SND_SPECIES_BASE + i]);
    ESP_LOGI(TAG, "synth: %d species cries, spiram %u -> %u",
             SND_SPECIES_COUNT, (unsigned)free_before,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}

static void play_sound(uint8_t id)
{
    if (audio_queue && id < SND_COUNT) xQueueSend(audio_queue, &id, 0);  // drop if busy
}

static void audio_task(void *arg)
{
    uint8_t id;
    for (;;) {
        if (xQueueReceive(audio_queue, &id, portMAX_DELAY) == pdTRUE &&
            g_codec && id < SND_COUNT && g_snd[id])
            g_codec->write(g_snd[id], g_snd_bytes[id]);   // blocks until pushed to I2S
    }
}

// ---- multi_button glue (runs on the esp_timer task; only enqueues) ---------
static Button KeyBtn;
static Button BootBtn;

static uint8_t read_btn(uint8_t button_id)
{
    return gpio_get_level(button_id == KEY_ID_KEY ? (gpio_num_t)KEY_GPIO
                                                  : (gpio_num_t)BOOT_GPIO);
}

static void btn_emit(uint8_t key_id, uint8_t kind_id)
{
    uint16_t ev = ((uint16_t)key_id << 8) | kind_id;
    xQueueSend(btn_queue, &ev, 0);                 // drop if full; events are advisory
}

static void on_key_single(Button *)  { btn_emit(KEY_ID_KEY, KIND_SHORT); play_sound(g_active_cry.load()); }
static void on_key_double(Button *)  { btn_emit(KEY_ID_KEY,  KIND_DOUBLE); }
static void on_key_long(Button *)    { btn_emit(KEY_ID_KEY,  KIND_LONG);   }
static void on_boot_single(Button *) { btn_emit(KEY_ID_BOOT, KIND_SHORT);  }
static void on_boot_double(Button *) { btn_emit(KEY_ID_BOOT, KIND_DOUBLE); }
static void on_boot_long(Button *)   { btn_emit(KEY_ID_BOOT, KIND_LONG);   }

static void btn_tick_cb(void *) { button_ticks(); }

static void buttons_init(void)
{
    gpio_config_t gc = {};
    gc.mode         = GPIO_MODE_INPUT;
    gc.pin_bit_mask = (1ULL << KEY_GPIO) | (1ULL << BOOT_GPIO);
    gc.pull_up_en   = GPIO_PULLUP_ENABLE;
    ESP_ERROR_CHECK_WITHOUT_ABORT(gpio_config(&gc));

    button_init(&KeyBtn, read_btn, 0, KEY_ID_KEY);     // active low
    button_attach(&KeyBtn, BTN_SINGLE_CLICK,     on_key_single);
    button_attach(&KeyBtn, BTN_DOUBLE_CLICK,     on_key_double);
    button_attach(&KeyBtn, BTN_LONG_PRESS_START, on_key_long);
    button_start(&KeyBtn);

    button_init(&BootBtn, read_btn, 0, KEY_ID_BOOT);
    button_attach(&BootBtn, BTN_SINGLE_CLICK,     on_boot_single);
    button_attach(&BootBtn, BTN_DOUBLE_CLICK,     on_boot_double);
    button_attach(&BootBtn, BTN_LONG_PRESS_START, on_boot_long);
    button_start(&BootBtn);

    esp_timer_create_args_t targs = {};
    targs.callback = btn_tick_cb;
    targs.name     = "btn_tick";
    esp_timer_handle_t th = nullptr;
    ESP_ERROR_CHECK(esp_timer_create(&targs, &th));
    ESP_ERROR_CHECK(esp_timer_start_periodic(th, 5000));   // 5ms tick (multi_button)
}

// ---- WiFi bring-up (Phase 2) ------------------------------------------------
static void start_mdns_once(void)
{
    if (g_mdns_started) return;
    g_mdns_started = true;
    ESP_ERROR_CHECK(mdns_init());
    ESP_ERROR_CHECK(mdns_hostname_set("cpb-buddy"));
    ESP_ERROR_CHECK(mdns_instance_name_set("Claude Pokemon Buddy"));
    ESP_ERROR_CHECK(mdns_service_add(nullptr, "_cpb", "_tcp", WIFI_TCP_PORT, nullptr, 0));
    ESP_LOGI(TAG, "mdns: advertising _cpb._tcp on port %u", (unsigned)WIFI_TCP_PORT);
}

static void apply_wifi_credential(int idx)
{
    wifi_config_t wc = {};
    const WifiCred &c = WIFI_CREDS[idx];
    strncpy((char *)wc.sta.ssid, c.ssid, sizeof(wc.sta.ssid) - 1);
    strncpy((char *)wc.sta.password, c.pass, sizeof(wc.sta.password) - 1);
    wc.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_LOGI(TAG, "wifi: trying \"%s\"", c.ssid);
}

// All retry/fallback logic lives here rather than a separate polling task:
// STA_START applies the first credential and connects; STA_DISCONNECTED
// (auth failure, AP out of range, or a genuine drop after a successful
// connect) advances to the next credential and retries. A full pass over
// every credential without success backs off WIFI_RETRY_CYCLE_DELAY_MS
// before starting over, so a temporarily-unreachable network doesn't spin
// the radio in a hot loop.
static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        apply_wifi_credential(g_wifi_cred_idx.load());
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        int next = (g_wifi_cred_idx.load() + 1) % WIFI_CRED_COUNT;
        g_wifi_cred_idx.store(next);
        vTaskDelay(pdMS_TO_TICKS(next == 0 ? WIFI_RETRY_CYCLE_DELAY_MS : 500));
        apply_wifi_credential(next);
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        auto *event = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "wifi: got ip " IPSTR, IP2STR(&event->ip_info.ip));
        start_mdns_once();
    }
}

static void wifi_init_sta(void)
{
    esp_err_t nvs_err = nvs_flash_init();
    if (nvs_err == ESP_ERR_NVS_NO_FREE_PAGES || nvs_err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        nvs_err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(nvs_err);

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t wifi_cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&wifi_cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, nullptr, nullptr));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, nullptr, nullptr));

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start()); // -> WIFI_EVENT_STA_START -> handler applies first credential + connects
}

// Phase 2 reachability probe: accepts a connection and logs it, nothing else.
// Phase 3 replaces this body with the real frame-parsing accept loop (shared
// with parse_frames()/send_frame(), gated on a valid T_AUTH token). Having a
// listening socket up now lets WiFi bring-up be verified independently of
// the frame protocol -- "is the network up" and "does the protocol work"
// are different failure modes and easy to conflate when debugging blind on
// real hardware.
static void wifi_tcp_probe_task(void *)
{
    int listen_fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listen_fd < 0) {
        ESP_LOGE(TAG, "wifi: probe socket() failed errno=%d", errno);
        vTaskDelete(nullptr);
        return;
    }
    int opt = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(WIFI_TCP_PORT);
    if (bind(listen_fd, (sockaddr *)&addr, sizeof(addr)) != 0) {
        ESP_LOGE(TAG, "wifi: probe bind() failed errno=%d", errno);
        close(listen_fd);
        vTaskDelete(nullptr);
        return;
    }
    listen(listen_fd, 1);
    ESP_LOGI(TAG, "wifi: probe listening on tcp/%u", (unsigned)WIFI_TCP_PORT);

    for (;;) {
        sockaddr_in client_addr = {};
        socklen_t client_len = sizeof(client_addr);
        int client_fd = accept(listen_fd, (sockaddr *)&client_addr, &client_len);
        if (client_fd < 0) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        ESP_LOGI(TAG, "wifi: probe client connected from %s", inet_ntoa(client_addr.sin_addr));
        close(client_fd);
    }
}

extern "C" void app_main(void)
{
    ESP_LOGI(TAG, "B3: init ST7305 panel");
    RlcdPort.RLCD_Init();
    RlcdPort.RLCD_ColorClear(ColorWhite);
    // Boot/alive marker (bottom-right): proves firmware is up + waiting for host.
    for (int yy = H - 12; yy < H - 4; yy++)
        for (int xx = W - 12; xx < W - 4; xx++)
            RlcdPort.RLCD_SetPixel(xx, yy, ColorBlack);
    RlcdPort.RLCD_Display();

    rxbuf   = (uint8_t *) heap_caps_malloc(RX_MAX, MALLOC_CAP_SPIRAM);
    rectbuf = (uint8_t *) heap_caps_malloc(RECT_MAX, MALLOC_CAP_SPIRAM);
    assert(rxbuf && rectbuf);

    tx_mutex  = xSemaphoreCreateMutex();
    btn_queue = xQueueCreate(8, sizeof(uint16_t));
    assert(tx_mutex && btn_queue);

    usb_serial_jtag_driver_config_t cfg = {
        .tx_buffer_size = 1024,
        .rx_buffer_size = 4096,
    };
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&cfg));

    ESP_LOGI(TAG, "B3: usb-serial-jtag up; rx frames + button uplink");
    // rx + button first so downlink/ACK and button uplink stay alive regardless
    // of the I2C sensor's state.
    xTaskCreate(rx_task,     "rx",     8192, nullptr, 6, nullptr);
    xTaskCreate(button_task, "btnup",  3072, nullptr, 5, nullptr);
    buttons_init();

    // WiFi (Phase 2): connecting is fully event-driven (wifi_init_sta only
    // kicks it off), so this doesn't block the rest of app_main. Independent
    // of USB -- USB keeps working exactly as before regardless of WiFi state.
    wifi_init_sta();
    xTaskCreate(wifi_tcp_probe_task, "wifi_probe", 4096, nullptr, 4, nullptr);

    // I2C/SHTC3 deferred out of static init (see g_bus note). Sensor uplink last.
    g_bus    = new I2cMasterBus(I2C_SCL, I2C_SDA, 0);
    g_sensor = new Shtc3(*g_bus);
    xTaskCreate(sensor_task, "sensor", 3072, nullptr, 4, nullptr);
    ESP_LOGI(TAG, "B3: sensor up");

    // Audio last: codec_board's init_codec reuses g_bus's I2C bus for the ES8311
    // control port (codec_init.c _i2c_init), so g_bus must exist first. KEY
    // single-click then plays the active species cry selected by host CONFIG.
    audio_queue = xQueueCreate(4, sizeof(uint8_t));
    assert(audio_queue);
    g_codec = new CodecPort("S3_RLCD_4_2");
    g_codec->open(AUDIO_SR, AUDIO_CH, 16);
    g_codec->set_volume(g_volume.load());
    synth_all();
    xTaskCreate(audio_task, "audio", 4096, nullptr, 4, nullptr);
    ESP_LOGI(TAG, "B5: codec up; 3 system + 18 species sounds (KEY=active cry, PLAY=evolve/hour)");
    xTaskCreate(hello_task, "hello", 2048, nullptr, 3, nullptr);
}
