// Claude Pokemon Buddy firmware - Milestone B5
//
// Builds on B4's ES8311 audio with host-driven sounds: the host sends a PLAY
// frame (type 0x03, payload[0] = sound id) so it can chime the buddy on its own
// events, and sends CONFIG (type 0x04, payload[0] = sound id) to set the local
// KEY-press cry. Three system sounds, the species cries and the capture-screen
// music are synthesized on demand; PLAY selects a sound immediately while KEY
// plays the active cry. One of those ids (SND_BGM_CAPTURE) is a LOOP rather than
// a sound: it repeats until the host asks it to stop or anything else is queued.
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
#include <errno.h>
#include <math.h>
#include <stdarg.h>
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
#include "nvs.h"
#include "mdns.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"

#include "display_bsp.h"
#include "shtc3.h"
#include "pcf85063.h"
#include "multi_button.h"
#include "codec_bsp.h"
#include "codec_init.h"
#include "sdmmc_cmd.h"

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
// Same bus, same constraint: built in app_main, not during static init.
static Pcf85063 *g_rtc = nullptr;

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
static constexpr uint8_t T_TIME   = 0x05;   // host -> device: [hour u8][minute u8][epoch_day u16 LE], local-clock time+date sync
static constexpr uint8_t T_VOLUME = 0x25;   // host -> device: set codec volume 0..100
static constexpr uint8_t T_HELLO  = 0x81;
static constexpr uint8_t T_BUTTON = 0x82;
static constexpr uint8_t T_SENSOR = 0x83;
static constexpr uint8_t T_ACK    = 0x84;
static constexpr uint8_t T_NACK   = 0x85;
static constexpr uint8_t T_AUTH   = 0x86;   // host -> device (wifi only): pre-shared pairing token
static constexpr uint8_t T_RESYNC = 0x87;   // device -> host: screen was drawn outside diff tracking, force full redraw
static constexpr uint8_t T_OFFLINE = 0x88;  // device -> host: [epoch_day u16 LE][hours u24 LE], hours a KEY press happened with no host

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
// Real credentials live in wifi_creds.h, which is gitignored (copy
// wifi_creds.h.example and fill it in, one file per machine). This file is
// tracked and this repo is public, so a WPA passphrase edited in here would be
// one `git add .` away from being published -- hence the indirection rather
// than a comment asking people to remember. With no wifi_creds.h present the
// placeholders below still compile; the device simply never joins a network,
// which is the right failure for anyone who cloned this without their own copy.
// CPB_HAVE_WIFI_CREDS is set by main/CMakeLists.txt when that file exists.
// __has_include was tried first and silently evaluated false under this
// toolchain, which flashed placeholder credentials while looking like it had
// worked -- a compile definition leaves no room for that.
#ifdef CPB_HAVE_WIFI_CREDS
#include "wifi_creds.h"
#else
static const WifiCred WIFI_CREDS[] = {
    { "CHANGE_ME_HOME_SSID", "CHANGE_ME_HOME_PASSWORD" },
    { "CHANGE_ME_WORK_SSID", "CHANGE_ME_WORK_PASSWORD" },
};
#endif
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

// ---- Device mode -- NORMAL processes T_FRAME as always; LOCAL_CLOCK shows
// the standalone clock screen instead. A manually-entered (KEY double-click)
// LOCAL_CLOCK NACKs T_FRAME immediately -- rather than silently dropping it --
// so the host's retry logic fails fast instead of waiting out the full ACK
// timeout on every attempt; only a KEY press exits. An auto-entered (timeout)
// LOCAL_CLOCK instead exits and processes the very first live T_FRAME that
// arrives, so connectivity coming back recovers on its own. Declared up here
// (ahead of its own section further down) because parse_frames reads it.
enum class DeviceMode : uint8_t { NORMAL, LOCAL_CLOCK };
static std::atomic<DeviceMode> g_mode{DeviceMode::NORMAL};
// Only entry via KEY double-click sets this + stops the radio; the Phase D
// auto-timeout path leaves WiFi alone so it keeps retrying in the
// background. Exit restarts the radio only if this flag says WE stopped it.
static std::atomic<bool> g_wifi_user_stopped{false};
// esp_timer_get_time() at the last authenticated T_FRAME (either link). Starts
// at 0 (boot), so a device that never hears from a host also falls back to
// the clock after the timeout -- consistent with "show the clock instead of
// a frozen/blank screen" rather than a special-cased startup state.
static std::atomic<int64_t> g_last_frame_us{0};
static constexpr int64_t LOCAL_CLOCK_TIMEOUT_US = 120LL * 1000 * 1000; // 2x the normal ~60s tick
// esp_timer_get_time() at the last EXIT from local-clock mode. A BOOT double
// inside this window is refused, so mashing BOOT cannot walk straight back into
// power-save -- see the button handler for how that happens. Two seconds: long
// enough to swallow the rest of a burst of presses, short enough that someone
// deliberately toggling it off and on again does not notice. The guard is on
// entry only; leaving must never be gated on a timer.
static constexpr int64_t BOOT_REARM_GUARD_US = 2LL * 1000 * 1000;
// Far enough in the past that the first BOOT double after boot is not swallowed
// by a guard with no exit to measure from.
static std::atomic<int64_t> g_local_clock_left_us{-BOOT_REARM_GUARD_US * 2};

// "Is anybody driving this panel right now" -- asked in the only direction that
// can be answered honestly, which is INBOUND. A live host pushes a frame about
// three times a second (the animator), so 30 seconds of silence is unambiguous,
// and it bounds how much of a commute's start can be missed.
//
// Not the same question as LOCAL_CLOCK_TIMEOUT_US, which is "has it been gone
// long enough to put the clock face up" and can afford to be slow.
//
// g_last_frame_us starts at 0, so a device that has never been drawn to counts
// as absent, which is what it is.
static constexpr int64_t HOST_SILENT_US = 30LL * 1000 * 1000;

static bool host_is_absent(void)
{
    return esp_timer_get_time() - g_last_frame_us.load() > HOST_SILENT_US;
}

static SemaphoreHandle_t tx_mutex = nullptr;      // serializes USJ writes
// Serializes EVERY write to the physical panel. There are exactly two writers --
// rx_task blitting a host frame (handle_frame_payload) and local_clock_task
// drawing the standalone clock -- and until 2026-08-01 nothing kept them apart
// but a `g_mode` check at the top of the clock task's loop. That is check-then-
// act, and the window is a whole clock redraw: ColorClear, the time, the ganzhi
// row, then a full-panel RLCD_Display(). Press BOOT to leave power-save in that
// window and the mode flips to NORMAL, the host is told to repaint, and rx_task
// starts blitting into the same driver a half-finished clock draw is still using.
//
// Observed result, twice on 2026-08-01: RLCD_Display() never returns, so rx_task
// stops ACKing forever. The panel stays frozen on the clock face, buttons still
// reach the host (they are queued from the esp_timer task, which is untouched),
// and the ONLY way out is a power cycle -- which is exactly how it presented:
// "the panel is stuck on the default display", with a host that looked healthy
// because it renders and pushes regardless of whether anything is accepted.
static SemaphoreHandle_t panel_mutex = nullptr;
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
// The capture screen's music, ABOVE the species range rather than beside
// BUI/EVOLVE/HOUR. Inserting ids at the bottom would push every species cry up by
// three, and a cry id is `soundBase + index` on the host -- until the two sides
// were reflashed in lockstep every cry would name the wrong pokemon out loud.
static constexpr uint8_t SND_EXTRA_BASE = SND_SPECIES_BASE + SND_SPECIES_COUNT;
#include "music.inc"
static constexpr uint8_t SND_BGM_CAPTURE = SND_EXTRA_BASE + SND_EXTRA_BGM_CAPTURE;
static constexpr uint8_t SND_BGM_STOP    = SND_EXTRA_BASE + SND_EXTRA_BGM_STOP;
static constexpr uint8_t SND_CAUGHT      = SND_EXTRA_BASE + SND_EXTRA_CAUGHT;
// Distinct from SND_EVOLVE, which stays what it always was and is now honestly
// just the hatching sound -- onboarding is the only thing still asking for it.
static constexpr uint8_t SND_EVOLUTION   = SND_EXTRA_BASE + SND_EXTRA_EVOLUTION;
// Derived, not written down. This was a literal 21 and the static_assert below
// caught it the moment species_cries.inc grew to 156 cries -- which is the assert
// doing its job, but the literal should never have been there to need catching.
static constexpr uint8_t SND_COUNT = SND_EXTRA_BASE + SND_EXTRA_COUNT;
static_assert(SND_SPECIES_BASE == 3, "species ids must start after BUI/EVOLVE/HOUR");
// A sound id travels as ONE byte in the PLAY and CONFIG payloads, so the table can
// never exceed 255 entries without a protocol change on both sides.
static_assert(SND_EXTRA_BASE + SND_EXTRA_COUNT <= 255,
              "sound ids are a single protocol byte -- the table cannot exceed 255");
static CodecPort    *g_codec = nullptr;
// One scratch buffer, sized at boot to the longest sound and reused for every
// playback. See synth_init(). Only audio_task ever writes it, and it holds the
// queue's only consumer, so no lock is needed.
static int16_t      *g_snd = nullptr;             // scratch PCM buffer (PSRAM)
static size_t        g_snd_bytes = 0;             // its capacity, 0 = audio disabled
static QueueHandle_t audio_queue = nullptr;       // sound id -> audio_task
static std::atomic<uint8_t> g_active_cry{SND_BUI};  // KEY-press cry; set by host CONFIG
// True from the moment SND_BGM_CAPTURE is queued until the loop gives up the
// speaker. Read by on_key_single: while the capture screen is up KEY is the throw
// button, and firing the buddy's cry on every throw would both talk over the music
// and kill it (any queued sound breaks the loop, by design).
static std::atomic<bool>    g_bgm_active{false};
static std::atomic<uint8_t> g_volume{80};
static void play_sound(uint8_t id);               // fwd decl (used by parse_frames)
static void handle_time_sync(uint8_t hour, uint8_t minute, uint16_t epoch_day); // fwd decl (used by parse_frames), defined with the rest of local-clock mode below
static void enter_local_clock_mode(bool user_initiated); // fwd decl (used by sensor_task's timeout watchdog)
static void exit_local_clock_mode(void);          // fwd decl (used by parse_frames' auto-recovery path)
static void offline_bond_note_press(void);        // fwd decl (button_task); defined with the clock it needs
static void offline_bond_publish(void);           // fwd decl (sensor_task)
static void rtc_seed_clock(void);                 // fwd decl (app_main); defined with the clock it feeds
static void rtc_maintain(void);                   // fwd decl (sensor_task)

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

// Diagnostic line straight out the USB-Serial-JTAG channel, prefixed so a
// reader can pick it out of the protocol bytes it shares the wire with (the
// host's parser skips anything that is not a frame, so this is safe to leave
// in). ESP_LOG is NOT usable for this: console output races with
// usb_serial_jtag_driver_install and is silently lost afterwards, which is
// exactly what happened the first time this wake path was investigated --
// a serial reader that captured nothing at all. See CLAUDE.md 8.1.
static void diag(const char *fmt, ...)
{
    char buf[160];
    int n = snprintf(buf, sizeof(buf), "\n#CPB %lu ", (unsigned long)(esp_timer_get_time() / 1000));
    if (n < 0 || n >= (int)sizeof(buf)) return;
    va_list ap;
    va_start(ap, fmt);
    int m = vsnprintf(buf + n, sizeof(buf) - n - 2, fmt, ap);
    va_end(ap);
    if (m < 0) return;
    size_t len = strnlen(buf, sizeof(buf) - 2);
    buf[len++] = '\n';
    usb_write_raw((const uint8_t *)buf, len);
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
//
// Do NOT try to read "did a host receive this" out of the return values here.
// That was tried on 2026-07-31 and is measurably wrong on both links:
// usb_serial_jtag_write_bytes completes as soon as the bytes fit the driver's
// 1KB TX ring buffer, whether or not anything is draining it, and wifi_write_raw
// deliberately reports "no client connected" as success. Use host_is_absent().
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

    // Everything above is decode and validation against `rectbuf` -- no panel
    // access -- so the lock is taken only for the blit itself and a malformed
    // frame is rejected without ever blocking the clock task.
    xSemaphoreTake(panel_mutex, portMAX_DELAY);
    for (uint16_t row = 0; row < h; row++) {
        const uint8_t *r = rectbuf + (size_t)row * rectRowBytes;
        for (uint16_t col = 0; col < w; col++) {
            uint8_t bit = (r[col >> 3] >> (7 - (col & 7))) & 1;
            RlcdPort.RLCD_SetPixel(x + col, y + row, bit ? ColorBlack : ColorWhite);
        }
    }
    RlcdPort.RLCD_Display();                       // blocks until SPI transfer done
    xSemaphoreGive(panel_mutex);
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
                if (g_mode.load() == DeviceMode::LOCAL_CLOCK && g_wifi_user_stopped.load()) {
                    send_nack(f[2], link);           // manual local-clock mode: only a KEY press exits
                } else {
                    // Auto-entered LOCAL_CLOCK (Phase D timeout, not a manual double-click)
                    // recovers the moment a live frame arrives on either link.
                    if (g_mode.load() == DeviceMode::LOCAL_CLOCK) exit_local_clock_mode();
                    g_last_frame_us.store(esp_timer_get_time());
                    if (have_seq && f[2] == last_seq) {
                        send_ack(f[2], link);            // duplicate retry: ACK, do not re-blit
                    } else if (handle_frame_payload(f + 5, len)) {
                        last_seq = f[2];
                        have_seq = true;
                        send_ack(f[2], link);            // ACK on success
                    } else {
                        send_nack(f[2], link);           // semantic reject: bad rect/RLE shape
                    }
                }
            } else if (f[1] == T_PLAY && len >= 1) {
                play_sound(f[5]);                  // payload[0] = sound id; fire-and-forget (no ACK)
            } else if (f[1] == T_CONFIG && len >= 1) {
                if (f[5] < SND_COUNT) g_active_cry.store(f[5]); // 非法 id 拒绝, 不改值
            } else if (f[1] == T_TIME && len == 4) {
                uint16_t epoch_day = (uint16_t)(f[7] | (f[8] << 8));
                handle_time_sync(f[5], f[6], epoch_day); // payload = [hour][minute][epoch_day LE]; malformed values ignored inside
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
// Also piggybacks the Phase D local-clock timeout watchdog: this task already
// runs continuously regardless of mode, and 30s is fine granularity for a
// 120s timeout, so a dedicated task isn't worth it.
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

        // Rides the sensor cadence rather than a link-up event: republishing a
        // mask that is already applied costs nothing (see the note above it),
        // and this way reconnecting over USB or WiFi needs no detection at all.
        rtc_maintain();
        offline_bond_publish();

        if (g_mode.load() == DeviceMode::NORMAL &&
            esp_timer_get_time() - g_last_frame_us.load() > LOCAL_CLOCK_TIMEOUT_US) {
            ESP_LOGI(TAG, "local-clock: no frame in %lld s, auto-entering", (long long)(LOCAL_CLOCK_TIMEOUT_US / 1000000));
            enter_local_clock_mode(false);
        }

        vTaskDelay(pdMS_TO_TICKS(SENSOR_PERIOD_MS));
    }
}

// user_initiated=true (KEY double-click) additionally stops the WiFi radio
// for real power savings and remembers to restart it on exit; the Phase D
// auto-timeout path (user_initiated=false) leaves WiFi alone so the
// existing credential-cycling reconnect keeps running in the background.
static void enter_local_clock_mode(bool user_initiated)
{
    if (g_mode.load() == DeviceMode::LOCAL_CLOCK) return;
    g_mode.store(DeviceMode::LOCAL_CLOCK);
    if (user_initiated) {
        g_wifi_user_stopped.store(true);
        esp_wifi_stop();
        ESP_LOGI(TAG, "local-clock: entered (manual, wifi stopped)");
    } else {
        ESP_LOGI(TAG, "local-clock: entered (auto, wifi still retrying)");
    }
}

static void exit_local_clock_mode(void)
{
    if (g_mode.load() == DeviceMode::NORMAL) return;
    g_mode.store(DeviceMode::NORMAL);
    if (g_wifi_user_stopped.load()) {
        diag("WAKE esp_wifi_start()");
        g_wifi_user_stopped.store(false);
        esp_wifi_start();   // re-triggers WIFI_EVENT_STA_START -> the normal connect flow
        diag("WAKE esp_wifi_start() returned");
    }
    // Barrier, not a critical section: g_mode is already NORMAL above, so taking
    // and immediately releasing the panel lock just waits out any clock redraw
    // that was already in flight when the mode flipped. Only then is the host
    // told to repaint. Without it the RESYNC races the tail of that redraw and
    // the host's full-frame blit lands on top of a half-drawn clock.
    xSemaphoreTake(panel_mutex, portMAX_DELAY);
    xSemaphoreGive(panel_mutex);

    // local_clock_task drew directly to the panel while we were away, which the
    // host's diff tracking never saw. Tell it to treat this like a fresh
    // connection (previousBytes reset + full-frame repaint) instead of pushing
    // a normal dirty-rect diff, which would leave clock-screen leftovers in any
    // region that happens to match the host's last-known pet frame.
    broadcast_frame(T_RESYNC, 0, nullptr, 0);
    ESP_LOGI(TAG, "local-clock: exited -> normal");
}

static void button_task(void *arg)
{
    uint16_t ev;                                   // (key_id << 8) | kind_id
    for (;;) {
        if (xQueueReceive(btn_queue, &ev, portMAX_DELAY) == pdTRUE) {
            uint8_t key_id = (uint8_t)(ev >> 8);
            uint8_t kind_id = (uint8_t)(ev & 0xff);
            uint8_t p[2] = { key_id, kind_id };
            broadcast_frame(T_BUTTON, 0, p, sizeof(p));
            ESP_LOGI(TAG, "button key=%u kind=%u", p[0], p[1]);

            // A KEY short press made with no host listening is the one the owner
            // otherwise loses -- it is both the greet gesture and the 亲密度
            // credit, and away from a PC nothing was there to count it. Record
            // the hour so the host can credit it on reconnect. Only KEY short:
            // every other gesture is answered by a screen the host draws, and
            // means nothing with no host to draw it.
            //
            // A false positive here is harmless by construction. The host
            // suppresses pushes while the pokedex or capture screen is up, so a
            // press then looks "absent" -- but those screens only exist because
            // a host is rendering them, so the same press is credited live and
            // the recorded hour replays as a no-op.
            if (key_id == KEY_ID_KEY && kind_id == KIND_SHORT && host_is_absent()) {
                offline_bond_note_press();
            }

            // ENTER power-save (manual local-clock) is on BOOT, not KEY. It used
            // to be KEY double-click, chosen because KEY short already means
            // "greet" and reusing short would have risked an accidental entry.
            // That reasoning held right up until 亲密度 became hourly: KEY short
            // is now a several-times-a-day habit, and the natural response to
            // "did that register?" is to press again -- straight into the
            // double-click window. Entry stops the WiFi radio with nothing on
            // screen to say so, and only another KEY press undoes it, so a
            // mistimed second press reads as "the device fell off the network
            // for no reason and never came back". BOOT has no daily function at
            // all, so it cannot be hit while playing with the buddy.
            //
            // EXIT is on BOOT too, so the whole power-save toggle lives on one
            // button and KEY is purely the buddy's. ANY BOOT press gets you out
            // -- deliberately more forgiving than entry, since being stuck on
            // the clock face is the bad state to be in, and someone who has
            // forgotten which gesture it was will mash the button.
            //
            // ⚠ Forgiving on exit is not enough on its own, and 2026-08-01 is
            // what proved it. Mashing BOOT does not produce N exits: the FIRST
            // press exits, and the next two land inside multi_button's
            // double-click window and emit KIND_DOUBLE -- which is the ENTER
            // gesture. Out, in, out, in, for as long as the owner keeps pressing.
            // The exit was made lenient precisely for someone who would mash, and
            // then mashing was made the way back in.
            //
            // So an entry is refused for BOOT_REARM_GUARD_US after an exit. The
            // guard is on entry only: getting out must never be gated on a timer.
            if (g_mode.load() == DeviceMode::LOCAL_CLOCK) {
                if (key_id == KEY_ID_BOOT) {
                    exit_local_clock_mode();
                    g_local_clock_left_us.store(esp_timer_get_time());
                }
            } else if (key_id == KEY_ID_BOOT && kind_id == KIND_DOUBLE) {
                if (esp_timer_get_time() - g_local_clock_left_us.load() < BOOT_REARM_GUARD_US) {
                    ESP_LOGI(TAG, "local-clock: entry ignored, still inside the re-arm guard");
                } else {
                    enter_local_clock_mode(true);
                }
            }
        }
    }
}

// The three system voices. At file scope rather than inside the old synth_all()
// because notes_for() below has to be able to reach them by id.
// Bui = two rising syllables. Evolve = a rising C-major arpeggio landing on a held
// high C. Hour = two short A5 beeps (a discreet chime).
static const Note BUI_NOTES[]    = { {520.f, 780.f, 110}, {0.f, 0.f, 40}, {760.f, 1150.f, 130} };
static const Note EVOLVE_NOTES[] = { {523.f, 523.f, 90}, {659.f, 659.f, 90},
                                     {784.f, 784.f, 90}, {1047.f, 1047.f, 240} };
static const Note HOUR_NOTES[]   = { {880.f, 880.f, 90}, {0.f, 0.f, 70}, {880.f, 880.f, 90} };

// id -> note sequence. Returns false for an id this build has no sound for, which
// is the normal case for a host that is newer than the flashed firmware: it will
// ask for cries this image does not carry, and the answer is silence, not a wrong
// species' cry.
static bool notes_for(uint8_t id, const Note **notes, int *count)
{
    switch (id) {
    case SND_BUI:    *notes = BUI_NOTES;    *count = 3; return true;
    case SND_EVOLVE: *notes = EVOLVE_NOTES; *count = 4; return true;
    case SND_HOUR:   *notes = HOUR_NOTES;   *count = 3; return true;
    case SND_CAUGHT:    *notes = CAUGHT_NOTES;    *count = CAUGHT_NOTE_COUNT;    return true;
    case SND_EVOLUTION: *notes = EVOLUTION_NOTES; *count = EVOLUTION_NOTE_COUNT; return true;
    // SND_BGM_CAPTURE is not a note sequence -- it is a phrase list played on a
    // loop, handled in play_bgm(). SND_BGM_STOP carries no audio at all; queueing
    // it is the whole point, because that is what breaks the loop.
    default: break;
    }
    if (id >= SND_SPECIES_BASE && id < SND_SPECIES_BASE + SND_SPECIES_COUNT) {
        const SpeciesCry &cry = SPECIES_CRIES[id - SND_SPECIES_BASE];
        *notes = cry.notes;
        *count = cry.count;
        return true;
    }
    return false;
}

static int frames_of(const Note *notes, int count)
{
    int frames = 0;
    for (int j = 0; j < count; j++) frames += AUDIO_SR * notes[j].ms / 1000;
    return frames;
}

// Render a square-wave note sequence into `out`, which must hold at least
// frames_of(notes, count) * AUDIO_CH samples. Each note gets a 5ms attack + linear
// decay so the chiptune voice has shape without clicks. Returns the byte count
// written. (Same synthesis as B4's chirp, reused for all sounds -- and mirrored
// sample-for-sample by host/scripts/cries-to-wav.mjs, so a change here has to be
// made there too or the audition tool starts lying.)
static size_t synth_tone(const Note *notes, int count, int16_t *out)
{
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
            out[idx++] = v;                        // L
            out[idx++] = v;                        // R
        }
    }
    return (size_t)idx * sizeof(int16_t);
}

// Allocate ONE buffer big enough for the longest sound, instead of pre-rendering
// every sound at boot.
//
// This used to synthesize all of them into their own PSRAM buffers up front. That
// was affordable at 21 sounds (~0.4MB) and stopped being affordable the moment the
// cry table grew to 156 (~2.4MB), on a board whose PSRAM size is
// CONFIG_SPIRAM_TYPE_AUTO and therefore not knowable at build time. Rendering a
// cry is a few thousand iterations of float multiply-add -- microseconds -- so
// precomputing 159 of them to avoid that was always the wrong trade, and it made
// the sound count a memory question when it should never have been one.
//
// Now the count is free: adding a cry costs nothing but flash for its note table.
static void synth_init(void)
{
    int max_frames = 0;
    for (int id = 0; id < SND_COUNT; id++) {
        const Note *notes; int count;
        if (!notes_for((uint8_t)id, &notes, &count)) continue;
        int frames = frames_of(notes, count);
        if (frames > max_frames) max_frames = frames;
    }

    // The BGM never passes through notes_for, so the loop above cannot see it.
    // One PHRASE at a time is what gets rendered, not the whole 12.8s loop --
    // that is why the tune is cut into bars in the seed. A single buffer for the
    // whole thing would be 400KB of PSRAM held forever to save a few hundred
    // microseconds of synthesis per bar.
    for (int p = 0; p < BGM_CAPTURE_PHRASE_COUNT; p++) {
        int frames = frames_of(BGM_CAPTURE_PHRASES[p].notes, BGM_CAPTURE_PHRASES[p].count);
        if (frames > max_frames) max_frames = frames;
    }

    g_snd_bytes = (size_t)max_frames * AUDIO_CH * sizeof(int16_t);
    g_snd = (int16_t *) heap_caps_malloc(g_snd_bytes, MALLOC_CAP_SPIRAM);
    if (g_snd == NULL) {
        ESP_LOGE(TAG, "synth_init: PSRAM alloc of %zu bytes failed -- audio disabled", g_snd_bytes);
        g_snd_bytes = 0;
        return;
    }
    ESP_LOGI(TAG, "synth: %d sounds on demand, one %u-byte buffer, spiram free %u",
             SND_COUNT, (unsigned)g_snd_bytes,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}

static void play_sound(uint8_t id)
{
    if (!audio_queue || id >= SND_COUNT) return;
    // Set on the ENQUEUE, not when the loop starts playing: the host sends the
    // BGM and the owner's first throw within the same few milliseconds, and a
    // flag set by audio_task would still be false when that KEY press is handled.
    if (id == SND_BGM_CAPTURE) g_bgm_active.store(true);
    else if (id == SND_BGM_STOP) g_bgm_active.store(false);
    xQueueSend(audio_queue, &id, 0);                     // drop if busy
}

// Push `bytes` of rendered PCM, in chunks, giving up the moment anything else is
// waiting in the queue. This is what makes the BGM interruptible: a single
// blocking write of a whole bar would hold the speaker for 1.6s, so the catch
// fanfare would land up to a bar and a half after the ball stopped rocking.
static constexpr int BGM_CHUNK_MS = 100;
static bool write_interruptible(const int16_t *pcm, size_t bytes)
{
    const size_t chunk = (size_t)(AUDIO_SR * BGM_CHUNK_MS / 1000) * AUDIO_CH * sizeof(int16_t);
    for (size_t off = 0; off < bytes; off += chunk) {
        if (uxQueueMessagesWaiting(audio_queue) > 0) return false;
        size_t n = (bytes - off < chunk) ? bytes - off : chunk;
        g_codec->write((const uint8_t *)pcm + off, (int)n);
    }
    return true;
}

// Runaway guard. The host stops the BGM in a `finally`, so this should never
// fire -- but a host that dies mid-capture would otherwise leave the device
// playing battle music until someone unplugged it, and the capture screen
// deliberately has no time limit of its own to bound this for us.
static constexpr int64_t BGM_MAX_US = 10LL * 60 * 1000 * 1000;

static void play_bgm(void)
{
    const int64_t deadline = esp_timer_get_time() + BGM_MAX_US;
    for (;;) {
        for (int p = 0; p < BGM_CAPTURE_PHRASE_COUNT; p++) {
            size_t bytes = synth_tone(BGM_CAPTURE_PHRASES[p].notes,
                                      BGM_CAPTURE_PHRASES[p].count, g_snd);
            if (!write_interruptible(g_snd, bytes)) { g_bgm_active.store(false); return; }
        }
        if (esp_timer_get_time() > deadline) {
            ESP_LOGW(TAG, "audio: capture BGM hit its %llds guard, stopping", BGM_MAX_US / 1000000);
            g_bgm_active.store(false);
            return;
        }
    }
}

static void audio_task(void *arg)
{
    uint8_t id;
    for (;;) {
        if (xQueueReceive(audio_queue, &id, portMAX_DELAY) != pdTRUE) continue;
        // Clears the flag on the way out: on a board with no codec the BGM is
        // never going to play, and leaving g_bgm_active latched would mute the
        // KEY cry for the rest of the boot.
        if (!g_codec || g_snd == nullptr) { g_bgm_active.store(false); continue; }

        if (id == SND_BGM_STOP) continue;                // control only; already flagged off
        if (id == SND_BGM_CAPTURE) { play_bgm(); continue; }

        const Note *notes; int count;
        if (!notes_for(id, &notes, &count)) continue;    // unknown id -> silence

        // Belt and braces: the buffer was sized to the longest sound this build
        // knows about, so this cannot overflow unless notes_for and synth_init
        // disagree. If they ever do, drop the sound rather than write past the end.
        size_t need = (size_t)frames_of(notes, count) * AUDIO_CH * sizeof(int16_t);
        if (need > g_snd_bytes) {
            ESP_LOGE(TAG, "audio: sound %u needs %zu > %zu bytes, dropped", id, need, g_snd_bytes);
            continue;
        }

        size_t bytes = synth_tone(notes, count, g_snd);
        g_codec->write(g_snd, bytes);                    // blocks until pushed to I2S
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

// The button event always goes up to the host -- during capture that press IS the
// throw. Only the cry is suppressed, and only while the capture music holds the
// speaker: see g_bgm_active.
static void on_key_single(Button *)
{
    btn_emit(KEY_ID_KEY, KIND_SHORT);
    if (!g_bgm_active.load()) play_sound(g_active_cry.load());
}
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

// The AP we were last actually associated with. Pinning its BSSID and channel
// turns the next connect from "scan every channel looking for this SSID" into
// "talk to this radio on this channel", which is the difference between a few
// seconds and a few hundred milliseconds. That matters because waking out of
// power-save stops and restarts the radio, so every wake pays for a full scan:
// measured ~6s from BOOT press to the buddy reappearing, of which roughly 5s
// was on the device and the scan is the bulk of it.
//
// Held in RAM only. It is a shortcut, not a setting -- a reboot, a moved
// device, or a router that reassigns channels should all just scan again.
static uint8_t g_wifi_pin_bssid[6] = {};
static uint8_t g_wifi_pin_channel = 0;
static std::atomic<bool> g_wifi_pin_valid{false};
static std::atomic<bool> g_wifi_pin_in_use{false};
static std::atomic<int> g_wifi_last_good_idx{-1};

// The lease that AP handed us, reused instead of re-running DHCP when we come
// straight back to the same radio. Measured on the wake path: association took
// 72ms and DHCP took 3.1s, so this is essentially the whole device-side cost.
//
// Safe because it is gated on the BSSID pin: reuse only ever happens when we
// are rejoining the exact AP we just left, which in practice means seconds to
// hours inside one sitting, well within any lease. Moving between locations
// changes the BSSID, the pin does not match, and DHCP runs normally. The time
// cap covers the case nobody plans for -- a device left in power-save for days
// and woken somewhere the lease has long since been reassigned.
static esp_netif_t *g_sta_netif = nullptr;
static esp_netif_ip_info_t g_wifi_lease = {};
static std::atomic<bool> g_wifi_lease_valid{false};
static std::atomic<bool> g_wifi_lease_in_use{false};
static int64_t g_wifi_lease_at_us = 0;
static constexpr int64_t WIFI_LEASE_MAX_AGE_US = 12LL * 3600 * 1000000; // 12h

static void wifi_restore_dhcp(void)
{
    if (!g_sta_netif) return;
    g_wifi_lease_in_use.store(false);
    esp_netif_dhcpc_start(g_sta_netif);   // already-started is not an error worth acting on
}

static void apply_wifi_credential(int idx, bool allow_pin = true)
{
    wifi_config_t wc = {};
    const WifiCred &c = WIFI_CREDS[idx];
    strncpy((char *)wc.sta.ssid, c.ssid, sizeof(wc.sta.ssid) - 1);
    strncpy((char *)wc.sta.password, c.pass, sizeof(wc.sta.password) - 1);
    wc.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;

    // Only pin for the credential the pin was recorded against -- pointing a
    // different SSID at that BSSID would just fail slowly.
    const bool pin = allow_pin && g_wifi_pin_valid.load() && idx == g_wifi_last_good_idx.load();
    if (pin) {
        memcpy(wc.sta.bssid, g_wifi_pin_bssid, sizeof(wc.sta.bssid));
        wc.sta.bssid_set = true;
        wc.sta.channel = g_wifi_pin_channel;
    }
    g_wifi_pin_in_use.store(pin);

    // Reuse the lease only alongside the pin -- same AP, same router, same
    // lease. Any other path (moved, rescanning, cold boot) goes back to DHCP.
    const bool lease_fresh = g_wifi_lease_valid.load() &&
        (esp_timer_get_time() - g_wifi_lease_at_us) < WIFI_LEASE_MAX_AGE_US;
    if (pin && lease_fresh && g_sta_netif) {
        esp_netif_dhcpc_stop(g_sta_netif);
        esp_netif_set_ip_info(g_sta_netif, &g_wifi_lease);
        g_wifi_lease_in_use.store(true);
    } else {
        wifi_restore_dhcp();
    }

    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    if (pin) {
        ESP_LOGI(TAG, "wifi: trying \"%s\" pinned to ch%u", c.ssid, (unsigned)g_wifi_pin_channel);
        diag("connect idx=%d pinned ch=%u", idx, (unsigned)g_wifi_pin_channel);
    } else {
        ESP_LOGI(TAG, "wifi: trying \"%s\"", c.ssid);
        diag("connect idx=%d scan", idx);
    }
}

// All retry/fallback logic lives here rather than a separate polling task:
// STA_START applies the current credential and connects; STA_DISCONNECTED
// (auth failure, AP out of range, or a genuine drop after a successful
// connect) retries and, if needed, moves on to the next credential. A full
// pass over every credential without success backs off
// WIFI_RETRY_CYCLE_DELAY_MS before starting over, so a temporarily-
// unreachable network doesn't spin the radio in a hot loop.
//
// The credential that last earned an IP is retried ONCE before the cycle
// advances. Without that, every single drop walks straight to a different
// SSID -- and with home and work both listed, "a different SSID" is by
// definition one that is not in range here, so each reconnect paid a failed
// association plus the cycle backoff before coming back to the network that
// was working seconds earlier. Measured as 10-18s of dead screen for what
// should be an immediate reconnect. With one credential configured this
// changes nothing (the cycle was already a no-op).
static std::atomic<bool> g_wifi_retry_last_good{false};

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
        // Splits the connect->GOT_IP gap into "found and joined the AP" and
        // "DHCP answered", which are different problems with different fixes.
        diag("ASSOCIATED");
        if (g_wifi_lease_in_use.load()) {
            // DHCP is stopped, so IP_EVENT_STA_GOT_IP will never arrive -- the
            // interface is already configured. Everything the GOT_IP branch
            // does has to happen here instead, or the device would be on the
            // network with no mDNS and no last-good credential recorded.
            diag("LEASE_REUSED " IPSTR, IP2STR(&g_wifi_lease.ip));
            g_wifi_last_good_idx.store(g_wifi_cred_idx.load());
            g_wifi_retry_last_good.store(true);
            g_wifi_pin_in_use.store(false);
            start_mdns_once();
        }
        return;
    }
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        diag("STA_START");
        apply_wifi_credential(g_wifi_cred_idx.load());
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        // The reason code is the whole point of instrumenting this: it says
        // whether a failed attempt timed out looking for the AP, was refused,
        // or was told to go away, which are three different bugs.
        const auto *d = (const wifi_event_sta_disconnected_t *)data;
        diag("DISCONNECTED reason=%u pinned=%d", (unsigned)(d ? d->reason : 0),
             g_wifi_pin_in_use.load() ? 1 : 0);
        // esp_wifi_stop() (manual local-clock mode) raises this too. Reconnecting
        // there would fight the user's own power-save request, and worse, the
        // esp_wifi_connect() below fails on a stopped radio without producing
        // another event -- which silently kills the retry loop for good, so the
        // device never rejoins even after the radio is started again.
        // Deliberately after the user_stopped check: entering power-save must
        // NOT throw the lease away, since coming straight back to the same AP
        // is the whole case it exists for.
        if (g_wifi_user_stopped.load()) return;

        // A session that was riding a reused lease has dropped. Do not assume
        // the address is still ours -- the next attempt earns a fresh one.
        if (g_wifi_lease_in_use.exchange(false)) {
            diag("LEASE_DROPPED");
            g_wifi_lease_valid.store(false);
            wifi_restore_dhcp();
        }

        // A pinned attempt that failed means the shortcut is wrong now (the AP
        // moved channel, or we are somewhere else entirely). Drop it and retry
        // the same credential with a normal scan before touching the cycle --
        // otherwise one stale BSSID would look exactly like the network being
        // gone and send us off to the other one.
        if (g_wifi_pin_in_use.exchange(false)) {
            ESP_LOGI(TAG, "wifi: pinned AP did not answer; rescanning");
            g_wifi_pin_valid.store(false);
            vTaskDelay(pdMS_TO_TICKS(200));
            apply_wifi_credential(g_wifi_cred_idx.load(), false);
            esp_wifi_connect();
            return;
        }

        if (g_wifi_retry_last_good.exchange(false)) {
            int same = g_wifi_last_good_idx.load();
            if (same >= 0) {
                g_wifi_cred_idx.store(same);
                vTaskDelay(pdMS_TO_TICKS(500));
                apply_wifi_credential(same);
                esp_wifi_connect();
                return;
            }
        }

        int next = (g_wifi_cred_idx.load() + 1) % WIFI_CRED_COUNT;
        g_wifi_cred_idx.store(next);
        vTaskDelay(pdMS_TO_TICKS(next == 0 ? WIFI_RETRY_CYCLE_DELAY_MS : 500));
        apply_wifi_credential(next);
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        auto *event = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "wifi: got ip " IPSTR, IP2STR(&event->ip_info.ip));
        diag("GOT_IP " IPSTR, IP2STR(&event->ip_info.ip));
        // Whatever we are on now is the network that is actually here. Pin it as
        // the one to try first next time, including after the radio is restarted
        // on the way out of manual local-clock mode.
        g_wifi_last_good_idx.store(g_wifi_cred_idx.load());
        g_wifi_retry_last_good.store(true);

        // And remember which radio on which channel, so the next connect can
        // skip the scan entirely.
        wifi_ap_record_t ap = {};
        if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
            memcpy(g_wifi_pin_bssid, ap.bssid, sizeof(g_wifi_pin_bssid));
            g_wifi_pin_channel = ap.primary;
            g_wifi_pin_valid.store(true);
            ESP_LOGI(TAG, "wifi: pinned ch%u for next connect", (unsigned)ap.primary);
        }
        // Keep the lease too: rejoining this same AP can then skip DHCP, which
        // measured 3.1s of the 3.7s device-side wake.
        g_wifi_lease = event->ip_info;
        g_wifi_lease_at_us = esp_timer_get_time();
        g_wifi_lease_valid.store(true);
        g_wifi_pin_in_use.store(false);
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
    g_sta_netif = esp_netif_create_default_wifi_sta();

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

// ---- Local clock mode (Phase A+B: font/rendering + time sync; mode
// switching/triggers are later phases). The device has no other text/font
// rendering capability anywhere (RLCD_SetPixel is the only primitive), so
// this is a from-scratch 5x7 bitmap font, block-scaled up (thin scaled
// pixels stay crisp on this 1-bit display; blurring doesn't). Prototyped and
// visually checked via a host-side canvas script before being hand-ported
// here -- see the commit message for what that looked like.
//
// No RTC chip driver exists in this codebase (stripped, per shtc3.h:2), so
// there's no battery-backed time source. Host already computes correct
// local wall-clock time every tick; T_TIME (host -> device, [hour u8][minute
// u8]) syncs it down periodically, and the device free-runs the displayed
// time from esp_timer between syncs -- no epoch/timezone math needed, good
// enough for gaps measured in minutes/hours, and it resets to accurate the
// moment the host is reachable again.
static constexpr int CLOCK_GLYPH_COLS = 5;
static constexpr int CLOCK_GLYPH_ROWS = 7;
// Row bit pattern per glyph, MSB = leftmost pixel. Index 10 = ':', 11 = '-'
// (the '-' glyph exists only to render a "--:--" no-time-yet placeholder).
static const uint8_t CLOCK_FONT[12][CLOCK_GLYPH_ROWS] = {
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
    { 0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000 }, // -
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

// text may only contain '0'-'9', ':', and '-'.
static int clock_glyph_index(char ch)
{
    if (ch == ':') return 10;
    if (ch == '-') return 11;
    return ch - '0';   // caller guarantees ch is otherwise '0'-'9'
}

static void draw_clock_text(const char *text, int cx, int cy, int scale, int gap)
{
    int x = cx - clock_text_width(text, scale, gap) / 2;
    int y = cy - (CLOCK_GLYPH_ROWS * scale) / 2;
    for (const char *p = text; *p; p++) {
        draw_clock_glyph(clock_glyph_index(*p), x, y, scale);
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
// 3 always-visible divider lines mark the 4 slot boundaries independent of
// fill state -- an unlit slot needs to read as "an empty slot", not blank
// icon background (matches the host-side fix in layout.js's
// drawBatteryIndicator, same bug, same reasoning).
static void draw_battery_icon(int cx, int y, int litSegments)
{
    constexpr int iconW = 40, iconH = 20, nubW = 4, segCount = 4;
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

    const int innerX = x + 2, innerY = y + 2;
    const int innerW = iconW - 4, innerH = iconH - 4;

    for (int i = 1; i < segCount; i++) {
        int dx = innerX + (innerW * i) / segCount;
        for (int j = 0; j < innerH; j++) RlcdPort.RLCD_SetPixel(dx, innerY + j, ColorBlack);
    }

    int litW = (innerW * (litSegments < segCount ? litSegments : segCount)) / segCount;
    if (litW > 0) draw_clock_rect(innerX, innerY, litW, innerH);
}

// Set by the T_TIME handler in parse_frames (any link, any mode -- this is
// what keeps the local clock accurate while otherwise disconnected).
// std::atomic matches this file's existing convention for small
// cross-task values (g_active_cry, g_volume) rather than a dedicated mutex.
static std::atomic<bool> g_clock_time_known{false};
static std::atomic<uint8_t> g_clock_base_hour{0};
static std::atomic<uint8_t> g_clock_base_minute{0};
static std::atomic<uint16_t> g_clock_base_epoch_day{0}; // days since 1970-01-01, local calendar date
static std::atomic<int64_t> g_clock_base_us{0};   // esp_timer_get_time() at the moment of the last sync

static void handle_time_sync(uint8_t hour, uint8_t minute, uint16_t epoch_day)
{
    if (hour > 23 || minute > 59) return;   // malformed payload -- ignore rather than display garbage
    g_clock_base_hour.store(hour);
    g_clock_base_minute.store(minute);
    g_clock_base_epoch_day.store(epoch_day);
    g_clock_base_us.store(esp_timer_get_time());
    g_clock_time_known.store(true);
}

// Free-runs from the last T_TIME sync using elapsed esp_timer microseconds.
// Returns false (hour/minute/epoch_day left untouched) if no sync has landed
// yet. Tracks day rollover too (elapsed_min crossing a 24h boundary advances
// epoch_day) -- matters for a device that's been disconnected across
// midnight, since the ganzhi date/day-pillar must not silently go stale.
static bool compute_current_clock(uint8_t &hour, uint8_t &minute, uint16_t &epoch_day)
{
    if (!g_clock_time_known.load()) return false;
    int64_t elapsed_us = esp_timer_get_time() - g_clock_base_us.load();
    int64_t elapsed_min = elapsed_us / 60'000'000LL;
    int64_t base_total_min = (int64_t)g_clock_base_hour.load() * 60 + (int64_t)g_clock_base_minute.load();
    int64_t total_min = base_total_min + elapsed_min;
    int64_t day_offset = total_min / (24 * 60);
    int64_t min_of_day = total_min % (24 * 60);
    if (min_of_day < 0) { min_of_day += 24 * 60; day_offset -= 1; }   // defensive; elapsed_us should never be negative
    hour = (uint8_t)(min_of_day / 60);
    minute = (uint8_t)(min_of_day % 60);
    epoch_day = (uint16_t)(g_clock_base_epoch_day.load() + day_offset);
    return true;
}

// ---- PCF85063, the board's RTC (2026-07-31) --------------------------------
// Until now the only clock was the one T_TIME sets, which lives in RAM and dies
// with a reboot. That was fine for the panel -- no host, nothing to draw -- and
// not fine for offline 亲密度, which has to name the HOUR a press happened in
// and correctly refuses to guess. The chip has been on the board all along; the
// driver was the missing half.
static void rtc_seed_clock(void)
{
    if (!g_rtc || !g_rtc->present()) {
        diag("rtc: absent");
        return;
    }
    uint8_t hour = 0, minute = 0;
    uint16_t day = 0;
    if (!g_rtc->read(&hour, &minute, &day)) {
        diag("rtc: no valid time");   // never set, or the backup rail dropped
        return;
    }
    handle_time_sync(hour, minute, day);
    diag("rtc: seeded %02u:%02u epoch_day=%u", (unsigned)hour, (unsigned)minute, (unsigned)day);
}

// Keeps the chip agreeing with whatever the host last told us. On the sensor
// cadence rather than on the T_TIME path deliberately: T_TIME is handled in
// rx_task, and an I2C round trip has no business on the frame parser.
//
// The one-minute deadband matters. Writing on every disagreement would rewrite
// the chip constantly, and every write zeroes the seconds register -- so a
// device with a host attached would be dragged permanently a few tens of
// seconds late, which is precisely the reading offline 亲密度 depends on.
static void rtc_maintain(void)
{
    if (!g_rtc || !g_rtc->present()) return;

    uint8_t hour = 0, minute = 0;
    uint16_t day = 0;
    if (!compute_current_clock(hour, minute, day)) return;   // nothing authoritative to write

    uint8_t rh = 0, rm = 0;
    uint16_t rd = 0;
    if (g_rtc->read(&rh, &rm, &rd)) {
        const int32_t chip = (int32_t)rd * 1440 + rh * 60 + rm;
        const int32_t host = (int32_t)day * 1440 + hour * 60 + minute;
        int32_t delta = chip - host;
        if (delta < 0) delta = -delta;
        if (delta <= 1) return;
    }

    if (g_rtc->write(hour, minute, day)) {
        diag("rtc: set to %02u:%02u epoch_day=%u", (unsigned)hour, (unsigned)minute, (unsigned)day);
    }
}

// ---- Offline 亲密度 (2026-07-31) -------------------------------------------
// 亲密度 is credited by the host, one hourly slot at a time, and a working day's
// slot only pays out if KEY was pressed while it was open. That press has to
// reach the host, so every press made away from a PC -- the commute, mostly --
// used to be worth nothing.
//
// What the device keeps is deliberately NOT an event log. It is one bitmask of
// the HOURS a press happened in, for a single day:
//
//     [epoch_day u16][hours u24]      bit h set = KEY was pressed during hour h
//
// Three properties fall out of that shape, and they are the whole reason for it:
//
//   * **Replaying it twice does nothing.** The host credits slots through its
//     own `bondSlots` bitmask, so re-applying an hour it already credited is a
//     no-op. There is no sequence number, no acknowledgement, and no "delete
//     after upload" step -- which is the step that loses data when an upload
//     fails after the delete.
//   * **It cannot grow.** Ten presses in one hour are one bit. A whole day is
//     five bytes whether the owner pressed once or a hundred times.
//   * **It needs no link-state machine.** Publishing is unconditional and
//     repeated (see sensor_task); if nobody is listening the write simply
//     fails, and the next one is 30 seconds away.
//
// The HOUR is what travels, not the slot index: which slot an hour maps to
// depends on the day's window (Thursday opens at 11, the rest at 9) and that
// table is the host's. The device stays free of the policy.
//
// Storage is NVS, not the SD card. This is a handful of bytes that must survive
// a brownout, which is exactly what NVS is for and exactly what a FAT volume on
// a removable card is not; the card can also simply be absent.
static constexpr const char *OFFLINE_NS      = "cpb";
static constexpr const char *OFFLINE_KEY_DAY = "obday";
static constexpr const char *OFFLINE_KEY_HRS = "obhrs";

static std::atomic<uint16_t> g_offline_day{0};
static std::atomic<uint32_t> g_offline_hours{0};

static void offline_bond_store(uint16_t day, uint32_t hours)
{
    nvs_handle_t h;
    if (nvs_open(OFFLINE_NS, NVS_READWRITE, &h) != ESP_OK) return;
    if (nvs_set_u16(h, OFFLINE_KEY_DAY, day) == ESP_OK &&
        nvs_set_u32(h, OFFLINE_KEY_HRS, hours) == ESP_OK) {
        nvs_commit(h);
    }
    nvs_close(h);
}

static void offline_bond_load(void)
{
    nvs_handle_t h;
    if (nvs_open(OFFLINE_NS, NVS_READONLY, &h) != ESP_OK) return;   // never written yet
    uint16_t day = 0;
    uint32_t hours = 0;
    if (nvs_get_u16(h, OFFLINE_KEY_DAY, &day) == ESP_OK &&
        nvs_get_u32(h, OFFLINE_KEY_HRS, &hours) == ESP_OK) {
        g_offline_day.store(day);
        g_offline_hours.store(hours);
        diag("offline-bond: restored day=%u hours=0x%06lx", (unsigned)day, (unsigned long)hours);
    }
    nvs_close(h);
}

// Called only when a KEY short press reached no host at all.
static void offline_bond_note_press(void)
{
    uint8_t hour = 0, minute = 0;
    uint16_t day = 0;
    if (!compute_current_clock(hour, minute, day)) {
        // Absent, not guessed -- the same rule the encounter context follows.
        // With no clock there is no hour to attribute the press to, and picking
        // one would hand over a half heart that was never earned. The device
        // has no RTC driver yet (the board's PCF85063 is unused), so this is
        // reachable only after a reboot with no host since.
        diag("offline-bond: press dropped, no time");
        return;
    }

    const bool same_day = g_offline_day.load() == day;
    const uint32_t hours = same_day ? g_offline_hours.load() : 0;
    const uint32_t next = hours | (1UL << hour);
    if (same_day && next == hours) return;   // this hour is already recorded

    g_offline_day.store(day);
    g_offline_hours.store(next);
    offline_bond_store(day, next);
    diag("offline-bond: hour %u recorded (day=%u hours=0x%06lx)",
         (unsigned)hour, (unsigned)day, (unsigned long)next);
}

// Fire-and-forget, called on the sensor cadence so reconnecting needs no
// link-up event to hang off: whenever a host is there, the next publish lands.
static void offline_bond_publish(void)
{
    if (g_offline_hours.load() == 0) return;

    uint8_t hour = 0, minute = 0;
    uint16_t today = 0;
    if (compute_current_clock(hour, minute, today) && g_offline_day.load() != today) {
        // The day rolled over while we were still holding it. The host resets
        // its slot mask per day and will never credit yesterday, so keeping
        // this only means republishing something guaranteed to be ignored.
        g_offline_day.store(today);
        g_offline_hours.store(0);
        offline_bond_store(today, 0);
        diag("offline-bond: dropped, day rolled over");
        return;
    }

    const uint16_t day = g_offline_day.load();
    const uint32_t hours = g_offline_hours.load();
    const uint8_t p[5] = {
        (uint8_t)(day & 0xff), (uint8_t)(day >> 8),
        (uint8_t)(hours & 0xff), (uint8_t)((hours >> 8) & 0xff), (uint8_t)((hours >> 16) & 0xff),
    };
    broadcast_frame(T_OFFLINE, 0, p, sizeof(p));
}

// ---- Ganzhi (stem-branch) date row -----------------------------------
// Southern-hemisphere-adjusted four-pillar date, shown centered above the
// clock. Derivation, southern-hemisphere rule, and verification against a
// user-confirmed reference date are documented in docs/local-clock-mode.md
// -- summary: year pillar is standard (li-chun anchored, unshifted); month
// pillar's stem is standard (wu-hu-dun) but its branch is flipped +6 to its
// seasonal-opposite pair; day and hour pillars are standard/hemisphere-
// independent pure formulas (day pillar is a simple continuous count, not
// tied to any calendar reform or season).
#include "ganzhi_font.inc"
#include "ganzhi_table.inc"

// Calibrated against 2026-07-27 (epoch_day 20661) = ren-yin day (stem8,
// branch2) -- see docs/local-clock-mode.md. The double-mod pattern handles
// C++'s negative-remainder `%` for epoch_day before the anchor.
static void ganzhi_day_pillar(uint16_t epoch_day, uint8_t &stem, uint8_t &branch)
{
    int32_t delta = (int32_t)epoch_day - 20661;
    stem = (uint8_t)(((delta + 8) % 10 + 10) % 10);
    branch = (uint8_t)(((delta + 2) % 12 + 12) % 12);
}

// wu-shu-dun (五鼠遁): day stem -> that day's zi-hour (23:00-00:59) stem.
// Hemisphere-independent, standard rule.
static constexpr uint8_t GANZHI_WUSHU_DUN[10] = { 0, 2, 4, 6, 8, 0, 2, 4, 6, 8 };

static void ganzhi_hour_pillar(uint8_t day_stem, uint8_t hour, uint8_t &stem, uint8_t &branch)
{
    branch = (uint8_t)(((hour + 1) / 2) % 12);
    stem = (uint8_t)((GANZHI_WUSHU_DUN[day_stem] + branch) % 10);
}

// Linear scan (table sorted ascending, ~63 entries -- a binary search isn't
// worth the complexity at this size) for the boundary active on epoch_day.
// Returns false if epoch_day falls before the table's first entry (not
// expected in practice, but the table doesn't cover all of time -- see
// gen-ganzhi-table.py's RANGE_START/RANGE_END).
static bool ganzhi_year_month(uint16_t epoch_day, uint8_t &year_stem, uint8_t &year_branch,
                               uint8_t &month_stem, uint8_t &month_branch)
{
    const GanzhiBoundary *active = nullptr;
    const size_t count = sizeof(GANZHI_TABLE) / sizeof(GANZHI_TABLE[0]);
    for (size_t i = 0; i < count; i++) {
        if (GANZHI_TABLE[i].epoch_day <= epoch_day) active = &GANZHI_TABLE[i];
        else break; // ascending order -- nothing further can match
    }
    if (!active) return false;
    year_stem = active->year_sb >> 4;
    year_branch = active->year_sb & 0x0F;
    month_stem = active->month_sb >> 4;
    month_branch = active->month_sb & 0x0F;
    return true;
}

static void draw_ganzhi_glyph(int glyph_idx, int x, int y)
{
    for (int r = 0; r < GANZHI_GLYPH_SIZE; r++) {
        for (int c = 0; c < GANZHI_GLYPH_SIZE; c++) {
            uint8_t byte = GANZHI_FONT[glyph_idx][r][c >> 3];
            if ((byte >> (7 - (c & 7))) & 1) RlcdPort.RLCD_SetPixel(x + c, y + r, ColorBlack);
        }
    }
}

// Composes the 15-glyph sequence [stem,branch,label,sep] x4 (no trailing
// separator) and centers it horizontally at cy. Glyph indices: stem 0-9
// direct, branch 10-21 (10+branch_idx), labels 22=年 23=月 24=日 25=时,
// separator 26.
static constexpr int GANZHI_ROW_GAP = 1;
static void draw_ganzhi_row(uint8_t ys, uint8_t yb, uint8_t ms, uint8_t mb,
                             uint8_t ds, uint8_t db, uint8_t hs, uint8_t hb, int cy)
{
    const int seq[] = {
        ys, 10 + yb, 22, 26,
        ms, 10 + mb, 23, 26,
        ds, 10 + db, 24, 26,
        hs, 10 + hb, 25,
    };
    constexpr int n = sizeof(seq) / sizeof(seq[0]);
    const int total_w = n * GANZHI_GLYPH_SIZE + (n - 1) * GANZHI_ROW_GAP;
    int x = W / 2 - total_w / 2;
    for (int i = 0; i < n; i++) {
        draw_ganzhi_glyph(seq[i], x, cy);
        x += GANZHI_GLYPH_SIZE + GANZHI_ROW_GAP;
    }
}

// time_known = false draws "--:--" (hour/minute ignored) rather than
// skipping the screen entirely -- lets a viewer tell "no sync yet" apart
// from "nothing is drawing at all" at a glance. battery_pct = BATTERY_UNKNOWN
// suppresses the icon entirely. The ganzhi row needs both a known time (for
// the hour pillar and epoch_day) and an epoch_day within GANZHI_TABLE's
// covered range -- either gap just omits that row rather than showing
// garbage, same "unknown -> omit, don't guess" spirit as time_known/battery.
static void draw_clock_screen(uint8_t hour, uint8_t minute, bool time_known, uint16_t epoch_day, uint8_t battery_pct)
{
    RlcdPort.RLCD_ColorClear(ColorWhite);
    if (time_known) {
        char buf[12]; // "HH:MM" is 5 chars + NUL, but uint8_t's range is 0-255 so size against the worst case
        snprintf(buf, sizeof(buf), "%02u:%02u", (unsigned)(hour % 100), (unsigned)(minute % 100));
        draw_clock_text(buf, W / 2, H / 2 - 10, 8, 10);

        uint8_t ys, yb, ms, mb;
        if (ganzhi_year_month(epoch_day, ys, yb, ms, mb)) {
            uint8_t ds, db, hs, hb;
            ganzhi_day_pillar(epoch_day, ds, db);
            ganzhi_hour_pillar(ds, hour, hs, hb);
            draw_ganzhi_row(ys, yb, ms, mb, ds, db, hs, hb, 20);
        }
    } else {
        draw_clock_text("--:--", W / 2, H / 2 - 10, 8, 10);
    }
    if (battery_pct != BATTERY_UNKNOWN) {
        int lit = (int)lroundf((battery_pct / 100.0f) * 4.0f);
        draw_battery_icon(W / 2, H / 2 + 50, lit);
    }
    RlcdPort.RLCD_Display();
}

// Draws only while g_mode is LOCAL_CLOCK **and** only under panel_mutex. The
// mode check came first (the Phase B version drew unconditionally and corrupted
// the host's diff-tracking) and was treated as sufficient for months; it is not.
// It says WHETHER to draw, the mutex says WHEN it is safe to -- see panel_mutex.
// 2s redraw cadence is enough for a clock (doesn't need to feel real-time)
// without redrawing so often it matters for the power savings this mode
// exists for.
static void local_clock_task(void *)
{
    for (;;) {
        // Cheap check first so a device in NORMAL mode never touches the lock at
        // all -- the buddy panel is the common case and it should not queue
        // behind a clock task that has nothing to draw.
        if (g_mode.load() == DeviceMode::LOCAL_CLOCK) {
            uint8_t hour = 0, minute = 0;
            uint16_t epoch_day = 0;
            bool known = compute_current_clock(hour, minute, epoch_day);
            const uint8_t battery = read_battery_percent();

            xSemaphoreTake(panel_mutex, portMAX_DELAY);
            // Re-read the mode INSIDE the lock. This is the half that is easy to
            // leave out and it fixes a second, quieter bug: waiting on the mutex
            // can take as long as a whole host blit, and the press that ends
            // power-save lands in exactly that window. Without this re-check the
            // clock face gets painted back over the buddy panel the host has just
            // restored, and stays there for the 2s until the next pass -- which
            // reads as "BOOT did nothing".
            if (g_mode.load() == DeviceMode::LOCAL_CLOCK) {
                draw_clock_screen(hour, minute, known, epoch_day, battery);
            }
            xSemaphoreGive(panel_mutex);
        }
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}

// ---- TF card probe (2026-07-31) --------------------------------------------
// The board's own pinout sheet gives CMD 21 / CLK 38 / DATA 39 with a single
// data line; those went into codec_board's board_cfg.txt, and codec_init.c
// derives the 1-bit bus width from d3 being absent. Nothing in the product
// uses the card yet -- this exists only to turn a claim on a diagram into a
// measurement on real hardware, which is why it also writes and reads a file
// back: a mount proves the pins, a round trip proves the filesystem.
//
// Reports through diag() rather than ESP_LOG, for the reason spelled out at
// diag() itself. Deliberately non-fatal in every branch: no card, a wrong
// pin or a corrupt filesystem must never cost a boot, because the buddy does
// not need the card for anything yet.
static void sdcard_probe(void)
{
    int err = mount_sdcard();
    if (err != ESP_OK) {
        diag("sdcard: mount failed err=0x%x (%s)", err, esp_err_to_name((esp_err_t) err));
        return;
    }

    sdmmc_card_t *card = (sdmmc_card_t *) get_sdcard_handle();
    if (card) {
        uint64_t mb = ((uint64_t) card->csd.capacity * card->csd.sector_size) >> 20;
        diag("sdcard: mounted %lluMB name=%.8s", mb, card->cid.name);
    } else {
        diag("sdcard: mounted but no card handle");
    }

    // Round trip through the FAT layer. Written to the mount root and removed
    // again, so a probe leaves nothing behind on the owner's card.
    //
    // The name is 8.3 and must stay that way: this build has
    // CONFIG_FATFS_LFN_NONE, so a longer stem fails fopen with EINVAL and
    // nothing else says why. "cpb-probe.txt" (9-char stem) did exactly that
    // and read as a broken card. Anything written to this card later -- the
    // offline event log especially -- lives under the same rule until someone
    // deliberately turns LFN on.
    const char *path = "/sdcard/cpbprobe.txt";
    FILE *w = fopen(path, "w");
    if (!w) {
        diag("sdcard: write open failed errno=%d", errno);
        return;
    }
    fputs("cpb probe\n", w);
    fclose(w);

    char line[32] = { 0 };
    FILE *r = fopen(path, "r");
    if (r) {
        if (!fgets(line, sizeof(line), r)) line[0] = '\0';
        fclose(r);
    }
    remove(path);
    diag("sdcard: readback %s", strncmp(line, "cpb probe", 9) == 0 ? "ok" : "FAILED");
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

    rxbuf     = (uint8_t *) heap_caps_malloc(RX_MAX, MALLOC_CAP_SPIRAM);
    rectbuf   = (uint8_t *) heap_caps_malloc(RECT_MAX, MALLOC_CAP_SPIRAM);
    wifi_rxbuf = (uint8_t *) heap_caps_malloc(RX_MAX, MALLOC_CAP_SPIRAM);
    assert(rxbuf && rectbuf && wifi_rxbuf);

    // panel_mutex before any task exists, so neither panel writer can start
    // without it. The boot splash above deliberately runs unlocked: app_main is
    // still the only thread at that point, and the mutex does not exist yet.
    tx_mutex      = xSemaphoreCreateMutex();
    wifi_tx_mutex = xSemaphoreCreateMutex();
    panel_mutex   = xSemaphoreCreateMutex();
    btn_queue     = xQueueCreate(8, sizeof(uint16_t));
    assert(tx_mutex && wifi_tx_mutex && panel_mutex && btn_queue);

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
    // Before anything can want the hour: with a charged 18650 this is the only
    // clock a device that rebooted away from a host will ever have.
    g_rtc    = new Pcf85063(*g_bus);
    rtc_seed_clock();
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
    synth_init();
    xTaskCreate(audio_task, "audio", 4096, nullptr, 4, nullptr);
    // Counts derived, not written out: this line said "18 species" for as long as
    // there were 18, and would have gone on saying it.
    ESP_LOGI(TAG, "B5: codec up; %d system + %d species + %d capture sounds, synthesized "
                  "on demand (KEY=active cry, PLAY=evolve/hour/capture)",
             SND_SPECIES_BASE, SND_SPECIES_COUNT, SND_EXTRA_COUNT);
    // After CodecPort, which is what tells codec_board which board's pin table
    // to parse -- get_sdcard_config reads that same parsed section.
    sdcard_probe();

    // Safe here: wifi_init_sta above already ran nvs_flash_init.
    offline_bond_load();

    xTaskCreate(hello_task, "hello", 2048, nullptr, 3, nullptr);

    // Safe to run continuously because every panel write -- this task's and
    // rx_task's -- goes through panel_mutex. The `g_mode` check alone was NOT
    // enough and wedged the device twice on 2026-08-01; see panel_mutex.
    xTaskCreate(local_clock_task, "local_clock", 3072, nullptr, 2, nullptr);
}
