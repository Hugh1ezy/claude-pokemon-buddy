# Local clock mode

The device can fall back to a standalone clock screen — no host required —
either automatically when the connection drops, or manually as a power-save
toggle. This is deliberately minimal: `HH:MM` plus a battery icon, nothing
else. Weather, usage stats, and the pet itself genuinely require the host;
this mode doesn't pretend otherwise.

## Two ways to enter

**Manual (power-save toggle).** Double-click **KEY** while in normal mode.
This also stops the WiFi radio (`esp_wifi_stop()`) for real power savings —
the dominant draw on battery is the radio, not the display. Any KEY press
(short or double) exits back to normal and restarts WiFi
(`esp_wifi_start()`), which kicks off an immediate reconnect attempt. Only a
KEY press exits manual mode — the device keeps NACKing `T_FRAME` the whole
time so the host's retry logic fails fast instead of waiting out the full
ACK timeout on every attempt.

**Automatic (connection-loss fallback).** If no authenticated `T_FRAME` has
landed on either link (USB or WiFi) for 120 seconds, the device enters the
same clock screen on its own — but leaves WiFi alone, so the existing
credential-cycling reconnect (see `docs/wifi.md`) keeps retrying in the
background exactly as it does today. The moment a live `T_FRAME` arrives
again (host restarted, WiFi back in range, USB replugged), the device exits
automatically and processes that frame normally — no button press needed.
This distinction (auto vs. manual) is tracked by a single flag
(`g_wifi_user_stopped`, `firmware/main/main.cpp`): it's only set true by the
manual double-click path, so it doubles as "did *we* stop the radio, and
does exiting require an explicit KEY press."

## How the clock stays roughly on time

The device has no RTC chip and no way to get wall-clock time on its own.
Instead, the host — which already computes correct local time every tick —
pushes it periodically via a small downlink opcode (`T_TIME`, `[hour
u8][minute u8]`, `host/src/transport/serial.js`'s `sendTime`). The firmware
stores `(hour, minute, esp_timer_get_time())` on receipt and free-runs the
displayed time from elapsed microseconds between syncs. `T_TIME` is
processed in every device mode — it's what keeps the clock accurate while
disconnected, which is the entire point.

If the device has never received a `T_TIME` sync (e.g. it auto-fell-back to
the clock before ever talking to a host), the screen shows `--:--` instead
of guessing. This is expected, not a bug — it only happens on a fresh boot
that hasn't yet connected to anything.

## Why exiting forces a full repaint

The clock screen is drawn directly to the panel by the device itself
(`local_clock_task`), completely outside the host's diff-based dirty-rect
tracking (`host/src/transport/index.js`'s `previousBytes`). If the device
just silently returned to normal mode, the host's next push would only
include pixels it *thinks* changed since the last frame it sent — leaving
stale clock-screen fragments wherever the new frame happens to match the
host's cached bitmap (most visible at the edges, since the pet sprite is
usually the only region that changes frame-to-frame).

To avoid this, exiting local-clock mode (either path) sends one `T_RESYNC`
frame (device → host, no payload). The host treats it exactly like a fresh
transport connection: reset `previousBytes` to null and push a full-frame
repaint instead of a diff (`host/src/transport/serial.js`'s `handleFrame`
reuses the same `"reconnect"` event a new port attach already emits).

## Known limitations

- No weather, usage stats, or pet state in this mode — see the scope note
  above.
- The auto-fallback timeout (120s) and the free-running clock's drift both
  reset the moment the host is reachable again; there's no attempt to track
  or compensate for drift beyond that.
- Manual mode can't be entered from LOCAL_CLOCK — double-click while already
  in the clock screen just exits, it doesn't do anything special.
