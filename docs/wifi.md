# WiFi transport (optional)

USB stays the default and priority transport — this is purely additive.
Enable it if you want the device running on battery only, without a data
cable tethering it to the computer.

## What it is

- Device joins your WiFi as a station (not an access point), so it lands on
  the same LAN as whichever computer is running the host — the host keeps
  its own internet access.
- Device advertises itself via mDNS (`_cpb._tcp.local`); the host discovers
  it (`host/src/transport/wifi.js`'s `findWifiHost`) instead of needing a
  fixed IP.
- Same wire protocol as USB (`host/src/transport/proto.js`), just carried
  over a TCP socket instead of USB-Serial-JTAG bytes — no separate
  reimplementation of the ACK/retry/reconnect logic (`wifi.js` hands its
  socket straight to `serial.js`'s `makeTransport`).
- A pre-shared pairing token (`T_AUTH`) gates the WiFi link: the device
  ignores everything from a socket — both directions, downlink commands and
  uplink sensor/button telemetry — until that socket has sent a matching
  token. USB has no such gate (physical possession is the trust boundary
  there); this matters most on a shared/workplace network where other
  people are on the same LAN.
- `host/src/transport/index.js`'s `createTransport()` always tries USB
  first; only tries WiFi if no USB device is found *and* `wifi.enabled` is
  set in config — both on startup and if a connected USB device is later
  unplugged mid-session (not just on a cold host start).

## Setup

Credentials are hardcoded into the firmware at flash time — there's no
on-device WiFi provisioning UI. This means changing a password means
re-flashing, but it's the simplest thing that works and keeps the
plaintext password out of any file that gets shared or committed.

**1. Install the ESP-IDF toolchain** (skip if `idf.py` already works):

```powershell
git clone -b v5.4 --recursive https://github.com/espressif/esp-idf.git "$HOME\esp\esp-idf"
cd "$HOME\esp\esp-idf"
powershell -ExecutionPolicy Bypass -File install.ps1 esp32s3
```

This downloads ~1-2GB and takes 20-40 minutes. Once installed, every new
shell needs the environment sourced before `idf.py` works:

```powershell
. "$HOME\esp\esp-idf\export.ps1"
```

**2. Edit credentials** in `firmware/main/main.cpp`, the `WIFI_CREDS` array:

```cpp
static const WifiCred WIFI_CREDS[] = {
    { "YOUR_HOME_SSID", "YOUR_HOME_PASSWORD" },
    { "YOUR_WORK_SSID", "YOUR_WORK_PASSWORD" },
};
```

Add or remove entries freely — the device tries each in turn on boot / on
disconnect and cycles through all of them indefinitely. **Never commit this
file with real credentials in it** — revert to placeholders before
committing (see `git diff firmware/main/main.cpp` shows no real SSID/password
before you `git add`).

**3. Set the pairing token** in `host/config.json` (gitignored — this file
never gets committed, so the real token only needs to exist here and in the
firmware source):

```json
{
  "wifi": {
    "enabled": true,
    "token": "<a random string, must match WIFI_PAIRING_TOKEN in main.cpp>"
  }
}
```

`WIFI_PAIRING_TOKEN` in `firmware/main/main.cpp` must be the exact same
string. Generate one with `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`.

**4. Build and flash:**

```powershell
cd "$HOME\claude-pokemon-buddy\firmware"
. "$HOME\esp\esp-idf\export.ps1"
idf.py build
$esptool = "<path to esptool.exe>"
& $esptool --chip esp32s3 --port COMx -b 460800 write-flash --flash-mode dio --flash-size 16MB --flash-freq 80m 0x0 build\bootloader\bootloader.bin 0x8000 build\partition_table\partition-table.bin 0x10000 build\pokemon_buddy_fw.bin
```

**5. Verify:** unplug USB, power the device from its 18650 battery (check
the PWR button — see hardware notes in `SETUP-WINDOWS.md`), and within
~20-30 seconds the host should log `ESP wifi device detected; upgrading
mock transport to wifi` and the screen should resume updating.

## Roaming between networks / going out of range

The credential list is tried in a loop: on `WIFI_EVENT_STA_DISCONNECTED`,
the firmware advances to the next credential and reconnects, backing off 5s
after a full failed pass over the whole list. In practice this means the
device re-attempts every ~10-20 seconds regardless of which network it last
had, so walking from a workplace network toward a home network (or vice
versa) reconnects automatically once you're back in range of *any*
configured SSID — no manual intervention needed.

While disconnected for more than ~2 minutes, the device stops waiting on a
frozen frame and switches to a standalone clock screen on its own — see
`docs/local-clock-mode.md` for how that works and what it does and doesn't
show. Button presses and sensor readings during a disconnected stretch are
not queued or replayed either way.

## Known limitations

- **Battery percentage is shown on screen** (next to the clock), read via
  the board's ADC on GPIO4 through its onboard 3x voltage divider, mapped
  against a 3.3V empty / 4.2V full window. The divider ratio and thresholds
  are per Waveshare's board docs, not independently verified against a
  multimeter — if the displayed number looks off against known battery
  state, recalibrate `BATTERY_EMPTY_V`/`BATTERY_FULL_V` in `main.cpp`
  (comment right above them explains why).
- **Battery life isn't precisely measured.** Continuous WiFi TX draws far
  more current than idle; expect well under a full day of continuous
  WiFi + display + audio use from a typical 18650 (2000-3000mAh), not
  "weeks on a charge."
- **HELLO is boot-time-only.** `hello_task` fires twice right after boot
  and self-deletes; a host that connects afterward (very likely for WiFi,
  since the TCP client connects well after the device has already booted
  and joined WiFi) never sees it. This is cosmetic — `getHello()` returning
  null is already handled everywhere it's read, it just means the one-time
  protocol-version-mismatch warning log never fires over WiFi. Pre-existing
  characteristic of the USB design too (a host that attaches after boot has
  the same gap), not something WiFi made worse.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Host never logs "upgrading mock transport to wifi" | `wifi.enabled` not set in `host/config.json`, or the token doesn't match `WIFI_PAIRING_TOKEN` in the flashed firmware |
| Device connects to WiFi (check router's client list) but host can't find it | mDNS traffic blocked between host and device — some routers/APs isolate clients from each other (client isolation / AP isolation) or block multicast; ask your network admin, or fall back to `host: "<device ip>", port: 7311` in config to bypass discovery |
| Device never joins any network | Double-check `WIFI_CREDS` in `firmware/main/main.cpp` was actually the version flashed (re-run `idf.py build` after editing, then reflash) |
| Screen frozen, host log shows wifi connected but no frame updates | Check `wifi.token` in `host/config.json` matches the firmware's `WIFI_PAIRING_TOKEN` exactly — a mismatched token silently drops everything (by design, see the auth gate above) |
