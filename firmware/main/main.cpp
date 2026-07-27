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
//   SENSOR 0x83 (out) = [temp i16 LE, units 0.1C][humidity u8 %][battery u8 %, 0xff=unknown]
//   BUTTON 0x82 (out) = [key_id][kind_id]   key 1=KEY/2=BOOT, kind 1=short/2=long/3=double
//   AUTH   0x86 (in, WiFi only) = [pairing token bytes]            -> gates the WiFi link
//
// Uplink frames are fire-and-forget: the host emits events on them without
// ACKing, so we never wait. All USB-Serial-JTAG writes go through send_frame()
// under tx_mutex so concurrent ACK / SENSOR / BUTTON frames never interleave.
// The same protocol also runs over a WiFi TCP link (see the WiFi bring-up
// section below) using the same frame format, an independent rx buffer/tx
// mutex per channel, and a Link enum threaded through send_frame/parse_frames
// to keep USB and WiFi from interfering with each other -- see docs/wifi.md.

#include <assert.h>
#include <math.h>
#include <stdio.h>
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
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"

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

// ---- Battery (18650 via onboard 3x resistor divider into GPIO4 / ADC1 CH3) --
// Divider ratio and the empty/full voltage window are per Waveshare's board
// docs, not independently measured against a multimeter -- if the on-screen
// percentage looks off against a known battery state, recalibrate these two
// thresholds rather than assuming the read is broken.
static constexpr adc_channel_t BATTERY_ADC_CHANNEL = ADC_CHANNEL_3; // GPIO4 on ESP32-S3 ADC1
static constexpr float BATTERY_DIVIDER_RATIO = 3.0f;
static constexpr float BATTERY_EMPTY_V = 3.3f;    // conservative empty cutoff under load, not the 2.5V absolute min
static constexpr float BATTERY_FULL_V  = 4.2f;
static constexpr uint8_t BATTERY_UNKNOWN = 0xff;  // sentinel: no battery / ADC unavailable

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

// Which physical channel a frame arrived on / should be sent on. USB and WiFi
// each get their own rx accumulation buffer, duplicate-ACK dedup state, and
// tx mutex (below) so they work fully independently -- e.g. a stalled WiFi
// client's send() blocking under wifi_tx_mutex never holds up USB uplink, and
// vice versa. Only T_FRAME/T_PLAY/T_CONFIG/T_VOLUME on the WIFI link require
// prior T_AUTH; USB is trusted implicitly (physical possession = the trust
// boundary there).
enum class Link : uint8_t { USB, WIFI };

static SemaphoreHandle_t wifi_tx_mutex = nullptr;
static int  g_wifi_client_fd = -1;                // -1 = no client connected
static bool g_wifi_authenticated = false;
static uint8_t *wifi_rxbuf = nullptr;             // WiFi frame accumulation (PSRAM), mirrors rxbuf
static size_t   wifi_rxlen = 0;
static bool     wifi_have_last_acked_frame_seq = false;
static uint8_t  wifi_last_acked_frame_seq = 0;

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

static bool usb_write_raw(const uint8_t *bytes, size_t total)
{
    xSemaphoreTake(tx_mutex, portMAX_DELAY);
    int written = usb_serial_jtag_write_bytes(bytes, total, pdMS_TO_TICKS(100));
    xSemaphoreGive(tx_mutex);
    return written == (int)total;
}

// Returns true when there's nothing to do (no client connected) as well as on
// a successful write -- only an actual write failure on a live socket is an
// error. On failure, drops the connection; wifi_link_task's accept loop
// notices via g_wifi_client_fd and starts listening for the next client.
static bool wifi_write_raw(const uint8_t *bytes, size_t total)
{
    xSemaphoreTake(wifi_tx_mutex, portMAX_DELAY);
    int fd = g_wifi_client_fd;
    bool ok = true;
    if (fd >= 0) {
        int written = send(fd, bytes, total, 0);
        ok = written == (int)total;
        if (!ok) {
            close(fd);
            g_wifi_client_fd = -1;
            g_wifi_authenticated = false;
        }
    }
    xSemaphoreGive(wifi_tx_mutex);
    return ok;
}

// Build [MAGIC|type|seq|len(2)|payload|crc32] and write it atomically on one
// channel. Outbound frames are always small (HELLO/ACK/NACK/SENSOR/BUTTON),
// unlike inbound FRAME payloads, hence the 64-byte cap.
static bool send_frame(uint8_t type, uint8_t seq, const uint8_t *payload, uint8_t len, Link link)
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
    const size_t total = 5 + (size_t)len + 4;
    bool ok = (link == Link::USB) ? usb_write_raw(f, total) : wifi_write_raw(f, total);
    if (!ok) {
        uint32_t drops = ++g_tx_drop_count;
        ESP_LOGW(TAG, "%s tx drop #%u type=0x%02x seq=%u",
                 link == Link::USB ? "serial" : "wifi", (unsigned)drops, type, seq);
    }
    return ok;
}

// Fire-and-forget uplink events (HELLO/SENSOR/BUTTON) have no seq semantics
// the host cares about, so they're safe to send on every currently-live,
// authenticated channel -- USB always (physical possession is the trust
// boundary there), WiFi only once that connection's T_AUTH has been
// accepted (an unauthenticated LAN peer shouldn't see sensor/button
// telemetry any more than it should be able to push frames). A no-op write
// when WiFi isn't connected/authed is not an error, see wifi_write_raw, so
// this never spams tx-drop warnings when WiFi is unused.
static void broadcast_frame(uint8_t type, uint8_t seq, const uint8_t *payload, uint8_t len)
{
    send_frame(type, seq, payload, len, Link::USB);
    if (g_wifi_authenticated) send_frame(type, seq, payload, len, Link::WIFI);
}

static void send_ack(uint8_t seq, Link link)
{
    send_frame(T_ACK, seq, &seq, 1, link);         // payload[0] = acked seq
}

static void send_nack(uint8_t seq, Link link)
{
    send_frame(T_NACK, seq, &seq, 1, link);        // payload[0] = rejected seq
}

static void send_hello(void)
{
    uint8_t p[2] = { PROTO_VER, SND_COUNT };
    broadcast_frame(T_HELLO, 0, p, sizeof(p));
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

// Shared by both channels: USB and WiFi each own their rx buffer, dedup
// state, and call this the same way (see the Link comment at its
// declaration). WIFI additionally requires a prior valid T_AUTH before
// anything else in the switch is acted on; USB does not.
static void parse_frames(uint8_t *buf, size_t &len_in_buf, Link link)
{
    bool &have_seq = (link == Link::USB) ? have_last_acked_frame_seq : wifi_have_last_acked_frame_seq;
    uint8_t &last_seq = (link == Link::USB) ? last_acked_frame_seq : wifi_last_acked_frame_seq;

    size_t pos = 0;
    while (len_in_buf - pos >= 5) {
        if (buf[pos] != MAGIC) { pos++; continue; }
        uint16_t len = buf[pos + 3] | (buf[pos + 4] << 8);
        if (len > MAX_INBOUND_PAYLOAD) { pos++; continue; }
        size_t frameLen = 5 + (size_t)len + 4;
        if (len_in_buf - pos < frameLen) break;
        const uint8_t *f = buf + pos;
        uint32_t got = f[5 + len] | (f[5 + len + 1] << 8) |
                       (f[5 + len + 2] << 16) | ((uint32_t)f[5 + len + 3] << 24);
        if (crc32(f, 5 + len) == got) {
            bool authed = (link == Link::USB) || g_wifi_authenticated;
            if (f[1] == T_AUTH) {
                if (link == Link::WIFI) {
                    g_wifi_authenticated = (len == strlen(WIFI_PAIRING_TOKEN) &&
                                             memcmp(f + 5, WIFI_PAIRING_TOKEN, len) == 0);
                    ESP_LOGI(TAG, "wifi: auth %s", g_wifi_authenticated ? "accepted" : "rejected");
                } // T_AUTH on USB is a no-op: nothing to gate there.
            } else if (!authed) {
                // Unauthenticated WiFi client sent something other than AUTH -> ignore it.
            } else if (f[1] == T_FRAME) {
                if (have_seq && f[2] == last_seq) {
                    send_ack(f[2], link);            // duplicate retry: ACK, do not re-blit
                } else if (handle_frame_payload(f + 5, len)) {
                    last_seq = f[2];
                    have_seq = true;
                    send_ack(f[2], link);            // ACK on success
                } else {
                    send_nack(f[2], link);           // semantic reject: bad rect/RLE shape
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
        memmove(buf, buf + pos, len_in_buf - pos);
        len_in_buf -= pos;
    }
}

static void rx_task(void *arg)
{
    uint8_t tmp[1024];
    for (;;) {
        int n = usb_serial_jtag_read_bytes(tmp, sizeof(tmp), pdMS_TO_TICKS(100));
        if (n <= 0) continue;
        if (rxlen + (size_t)n > RX_MAX) {
            parse_frames(rxbuf, rxlen, Link::USB); // drain any complete frames before dropping
            if (rxlen + (size_t)n > RX_MAX) {
                rxlen = 0;                        // backlog is unparseable garbage -> last-resort resync
            }
        }
        memcpy(rxbuf + rxlen, tmp, n);
        rxlen += n;
        parse_frames(rxbuf, rxlen, Link::USB);
    }
}

static adc_oneshot_unit_handle_t g_adc_handle = nullptr;
static adc_cali_handle_t g_adc_cali = nullptr;    // nullptr if calibration scheme unsupported on this chip revision

static void battery_adc_init(void)
{
    adc_oneshot_unit_init_cfg_t init_cfg = {};   // zero-init first so no field is left uninitialized
    init_cfg.unit_id = ADC_UNIT_1;
    init_cfg.ulp_mode = ADC_ULP_MODE_DISABLE;
    if (adc_oneshot_new_unit(&init_cfg, &g_adc_handle) != ESP_OK) {
        ESP_LOGW(TAG, "battery: adc_oneshot_new_unit failed, battery %% unavailable");
        g_adc_handle = nullptr;
        return;
    }

    adc_oneshot_chan_cfg_t chan_cfg = {
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    ESP_ERROR_CHECK(adc_oneshot_config_channel(g_adc_handle, BATTERY_ADC_CHANNEL, &chan_cfg));

    adc_cali_curve_fitting_config_t cali_cfg = {
        .unit_id = ADC_UNIT_1,
        .chan = BATTERY_ADC_CHANNEL,
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    if (adc_cali_create_scheme_curve_fitting(&cali_cfg, &g_adc_cali) != ESP_OK) {
        ESP_LOGW(TAG, "battery: no cali scheme available, using uncalibrated raw->mV approximation");
        g_adc_cali = nullptr;
    }
}

// Returns BATTERY_UNKNOWN if the ADC never initialized; otherwise 0-100.
static uint8_t read_battery_percent(void)
{
    if (!g_adc_handle) return BATTERY_UNKNOWN;

    int raw = 0;
    if (adc_oneshot_read(g_adc_handle, BATTERY_ADC_CHANNEL, &raw) != ESP_OK) return BATTERY_UNKNOWN;

    int mv;
    if (g_adc_cali && adc_cali_raw_to_voltage(g_adc_cali, raw, &mv) == ESP_OK) {
        // calibrated
    } else {
        mv = raw * 3300 / 4095;  // rough 12-bit/3.3V fallback when no calibration scheme is available
    }

    float batteryV = (mv / 1000.0f) * BATTERY_DIVIDER_RATIO;
    float pct = (batteryV - BATTERY_EMPTY_V) / (BATTERY_FULL_V - BATTERY_EMPTY_V) * 100.0f;
    if (pct < 0.0f) pct = 0.0f;
    if (pct > 100.0f) pct = 100.0f;
    return (uint8_t)lroundf(pct);
}

// Read SHTC3 every SENSOR_PERIOD_MS and uplink a SENSOR frame. First read runs
// immediately so the host's "room" field stops showing -- within a few seconds.
static void sensor_task(void *arg)
{
    for (;;) {
        float t, h;
        uint8_t battery = read_battery_percent();
        if (g_sensor->read(&t, &h)) {
            int16_t ti = (int16_t)lroundf(t * 10.0f);
            uint8_t p[4] = { (uint8_t)(ti & 0xff), (uint8_t)((ti >> 8) & 0xff),
                             (uint8_t)lroundf(h), battery };
            broadcast_frame(T_SENSOR, 0, p, sizeof(p));
            ESP_LOGI(TAG, "sensor %.1fC %.0f%% battery=%u", t, (double)h, battery);
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
            broadcast_frame(T_BUTTON, 0, p, sizeof(p));
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

// One client at a time, matching the trust model of a single USB cable: a
// second connection attempt just sits in the listen backlog (size 1) until
// the current client disconnects, since accept() isn't called again until
// this loop's recv() loop below exits.
static void wifi_link_task(void *)
{
    int listen_fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listen_fd < 0) {
        ESP_LOGE(TAG, "wifi: socket() failed errno=%d", errno);
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
        ESP_LOGE(TAG, "wifi: bind() failed errno=%d", errno);
        close(listen_fd);
        vTaskDelete(nullptr);
        return;
    }
    listen(listen_fd, 1);
    ESP_LOGI(TAG, "wifi: listening on tcp/%u", (unsigned)WIFI_TCP_PORT);

    for (;;) {
        sockaddr_in client_addr = {};
        socklen_t client_len = sizeof(client_addr);
        int client_fd = accept(listen_fd, (sockaddr *)&client_addr, &client_len);
        if (client_fd < 0) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        ESP_LOGI(TAG, "wifi: client connected from %s", inet_ntoa(client_addr.sin_addr));

        wifi_rxlen = 0;
        wifi_have_last_acked_frame_seq = false;
        g_wifi_authenticated = false;                 // must re-send T_AUTH on every new connection
        xSemaphoreTake(wifi_tx_mutex, portMAX_DELAY);
        g_wifi_client_fd = client_fd;
        xSemaphoreGive(wifi_tx_mutex);

        uint8_t tmp[1024];
        for (;;) {
            int n = recv(client_fd, tmp, sizeof(tmp), 0);
            if (n <= 0) break;                        // 0 = orderly close, <0 = error
            if (wifi_rxlen + (size_t)n > RX_MAX) {
                parse_frames(wifi_rxbuf, wifi_rxlen, Link::WIFI); // drain before dropping
                if (wifi_rxlen + (size_t)n > RX_MAX) wifi_rxlen = 0; // unparseable backlog -> resync
            }
            memcpy(wifi_rxbuf + wifi_rxlen, tmp, n);
            wifi_rxlen += n;
            parse_frames(wifi_rxbuf, wifi_rxlen, Link::WIFI);
        }

        ESP_LOGI(TAG, "wifi: client disconnected");
        xSemaphoreTake(wifi_tx_mutex, portMAX_DELAY);
        g_wifi_client_fd = -1;
        xSemaphoreGive(wifi_tx_mutex);
        g_wifi_authenticated = false;
        close(client_fd);
    }
}

// ---- Local clock mode (Phase A: font + rendering only -- no mode switching
// or triggers wired up yet, that's later phases). The device has no other
// text/font rendering capability anywhere (RLCD_SetPixel is the only
// primitive), so this is a from-scratch 5x7 bitmap font, block-scaled up
// (thin scaled pixels stay crisp on this 1-bit display; blurring doesn't).
// Prototyped and visually checked via a host-side canvas script before being
// hand-ported here -- see the commit message for what that looked like.
static constexpr int CLOCK_GLYPH_COLS = 5;
static constexpr int CLOCK_GLYPH_ROWS = 7;
// Row bit pattern per glyph, MSB = leftmost pixel. Index 10 = ':'.
static const uint8_t CLOCK_FONT[11][CLOCK_GLYPH_ROWS] = {
    { 0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110 }, // 0
    { 0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110 }, // 1
    { 0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111 }, // 2
    { 0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110 }, // 3
    { 0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010 }, // 4
    { 0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110 }, // 5
    { 0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110 }, // 6
    { 0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000 }, // 7
    { 0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110 }, // 8
    { 0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100 }, // 9
    { 0b00000, 0b00100, 0b00000, 0b00000, 0b00100, 0b00000, 0b00000 }, // :
};

static void draw_clock_glyph(int glyph_idx, int x, int y, int scale)
{
    for (int r = 0; r < CLOCK_GLYPH_ROWS; r++) {
        uint8_t row = CLOCK_FONT[glyph_idx][r];
        for (int c = 0; c < CLOCK_GLYPH_COLS; c++) {
            if (!((row >> (CLOCK_GLYPH_COLS - 1 - c)) & 1)) continue;
            for (int sy = 0; sy < scale; sy++)
                for (int sx = 0; sx < scale; sx++)
                    RlcdPort.RLCD_SetPixel(x + c * scale + sx, y + r * scale + sy, ColorBlack);
        }
    }
}

static int clock_text_width(const char *text, int scale, int gap)
{
    int len = (int)strlen(text);
    return len * CLOCK_GLYPH_COLS * scale + (len - 1) * gap;
}

// text may only contain '0'-'9' and ':'.
static void draw_clock_text(const char *text, int cx, int cy, int scale, int gap)
{
    int x = cx - clock_text_width(text, scale, gap) / 2;
    int y = cy - (CLOCK_GLYPH_ROWS * scale) / 2;
    for (const char *p = text; *p; p++) {
        draw_clock_glyph(*p == ':' ? 10 : (*p - '0'), x, y, scale);
        x += CLOCK_GLYPH_COLS * scale + gap;
    }
}

static void draw_clock_rect(int x, int y, int w, int h)
{
    for (int yy = 0; yy < h; yy++)
        for (int xx = 0; xx < w; xx++)
            RlcdPort.RLCD_SetPixel(x + xx, y + yy, ColorBlack);
}

// litSegments: 0-4 (25% each), matching the host's own battery indicator
// design (host/src/render/layout.js's drawBatteryIndicator) -- same visual
// language, independently drawn since the device can't reach the host to
// ask it to render anything while showing this screen at all.
static void draw_battery_icon(int cx, int y, int litSegments)
{
    constexpr int iconW = 40, iconH = 20, nubW = 4, segGap = 2, segCount = 4;
    int x = cx - iconW / 2;
    for (int i = 0; i < iconW; i++) {
        RlcdPort.RLCD_SetPixel(x + i, y, ColorBlack);
        RlcdPort.RLCD_SetPixel(x + i, y + iconH - 1, ColorBlack);
    }
    for (int j = 0; j < iconH; j++) {
        RlcdPort.RLCD_SetPixel(x, y + j, ColorBlack);
        RlcdPort.RLCD_SetPixel(x + iconW - 1, y + j, ColorBlack);
    }
    draw_clock_rect(x + iconW, y + (iconH - 8) / 2, nubW, 8);

    const int innerW = iconW - 8, innerH = iconH - 8;
    const float segW = (innerW - segGap * (segCount - 1)) / (float)segCount;
    for (int i = 0; i < litSegments && i < segCount; i++) {
        draw_clock_rect(x + 4 + (int)lroundf(i * (segW + segGap)), y + 4, (int)lroundf(segW), innerH);
    }
}

// battery_pct = BATTERY_UNKNOWN suppresses the icon entirely.
static void draw_clock_screen(uint8_t hour, uint8_t minute, uint8_t battery_pct)
{
    RlcdPort.RLCD_ColorClear(ColorWhite);
    char buf[12]; // "HH:MM" is 5 chars + NUL, but uint8_t's range is 0-255 so size against the worst case
    snprintf(buf, sizeof(buf), "%02u:%02u", (unsigned)(hour % 100), (unsigned)(minute % 100));
    draw_clock_text(buf, W / 2, H / 2 - 10, 8, 10);
    if (battery_pct != BATTERY_UNKNOWN) {
        int lit = (int)lroundf((battery_pct / 100.0f) * 4.0f);
        draw_battery_icon(W / 2, H / 2 + 50, lit);
    }
    RlcdPort.RLCD_Display();
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

    // TEMPORARY Phase-A scaffold: force the local-clock screen up for a fixed
    // window so it can be checked on real hardware in isolation, before any
    // real mode-switching exists to trigger it for real. Removed in Phase C.
    draw_clock_screen(14, 37, 75);
    vTaskDelay(pdMS_TO_TICKS(15000));

    rxbuf     = (uint8_t *) heap_caps_malloc(RX_MAX, MALLOC_CAP_SPIRAM);
    rectbuf   = (uint8_t *) heap_caps_malloc(RECT_MAX, MALLOC_CAP_SPIRAM);
    wifi_rxbuf = (uint8_t *) heap_caps_malloc(RX_MAX, MALLOC_CAP_SPIRAM);
    assert(rxbuf && rectbuf && wifi_rxbuf);

    tx_mutex      = xSemaphoreCreateMutex();
    wifi_tx_mutex = xSemaphoreCreateMutex();
    btn_queue     = xQueueCreate(8, sizeof(uint16_t));
    assert(tx_mutex && wifi_tx_mutex && btn_queue);

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
    xTaskCreate(wifi_link_task, "wifi_link", 4096, nullptr, 4, nullptr);

    // I2C/SHTC3 deferred out of static init (see g_bus note). Sensor uplink last.
    g_bus    = new I2cMasterBus(I2C_SCL, I2C_SDA, 0);
    g_sensor = new Shtc3(*g_bus);
    battery_adc_init();
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
