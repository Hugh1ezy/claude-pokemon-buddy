# Local clock mode

The device can fall back to a standalone clock screen — no host required —
either automatically when the connection drops, or manually as a power-save
toggle. This is deliberately minimal: `HH:MM`, a battery icon, and a ganzhi
(stem-branch) date row, nothing else. Weather, usage stats, and the pet
itself genuinely require the host; this mode doesn't pretend otherwise.

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
u8][minute u8][epoch_day u16 LE]`, `host/src/transport/serial.js`'s
`sendTime`; `epoch_day` is days since 1970-01-01, computed from the host's
local calendar date by `host/src/index.js`'s `epochDayFor`). The firmware
stores `(hour, minute, epoch_day, esp_timer_get_time())` on receipt and
free-runs both the displayed time *and* the date from elapsed microseconds
between syncs — `compute_current_clock` advances `epoch_day` too if enough
time passes to cross a midnight boundary, so a device that's been
disconnected overnight doesn't show yesterday's date. `T_TIME` is processed
in every device mode — it's what keeps the clock accurate while
disconnected, which is the entire point.

If the device has never received a `T_TIME` sync (e.g. it auto-fell-back to
the clock before ever talking to a host), the screen shows `--:--` and no
ganzhi row, instead of guessing. This is expected, not a bug — it only
happens on a fresh boot that hasn't yet connected to anything.

## The ganzhi (stem-branch) date row

Above the clock, a second row shows the four-pillar ganzhi date (e.g. `丙午
年 · 乙丑月 · 壬寅日 · 己酉时`) — a **southern-hemisphere-adjusted** variant,
tuned for the device owner's actual location, not the standard
China/Northern-hemisphere calendar.

**The adjustment rule** (confirmed against a user-supplied, independently-
computed reference date — see verification below): the **year pillar is
completely standard** (立春-anchored, unshifted). The **day and hour
pillars are standard** too — they're pure continuous counts/formulas with
no seasonal dependency at all, so there's nothing to adjust. Only the
**month pillar** changes: its *stem* is computed the normal way (五虎遁,
from the year stem and the month's position in sequence from 立春), but its
*branch* is replaced with its **seasonal-opposite pair** (+6 in the 12-branch
cycle, e.g. 未↔丑, 申↔寅) — so a month that's normally "small heat" (未,
mid-summer in the north) reads as its winter-equivalent branch (丑) for
someone actually experiencing winter at that time of year.

**Why a lookup table instead of computing this on-device.** Getting
Gregorian↔ganzhi conversion right by ad-hoc reasoning is exactly what went
wrong in an earlier, unrelated attempt at this same conversion — so this
implementation instead: (1) computes exact solar-term crossing times using
the JPL DE421 ephemeris via the `skyfield` Python package (not a hand-rolled
approximation), (2) converts those to the device owner's local timezone
(`Pacific/Auckland`, matching `host/config.json`'s configured location), (3)
derives year/month stem+branch from well-established, checkable rules
(五虎遁, the year-stem/branch anchor `1984 = 甲子`), and (4) verifies the
result two ways before trusting it: against well-known public facts
(solstice/equinox dates, and independently-known year pillars like `2020 =
庚子` and `2024 = 甲辰`), and against the user's own confirmed reference date
(`2026-07-27 17:26 Auckland = 丙午年·乙丑月·壬寅日·己酉时`). All of this
happens once, host-side, via `host/scripts/gen-ganzhi-table.py`
(`pip install skyfield` required — this is a rarely-run generator, not part
of the normal npm build) — the output is a compact boundary table
(`firmware/main/ganzhi_table.inc`, ~1 entry per solar-term month boundary)
that the firmware just looks up by `epoch_day`. The day and hour pillars
are plain formulas calibrated against that same verified anchor date,
computed on-device with no table needed.

**Rendering.** The device has no font-rendering engine, so the 27 needed
CJK glyphs (10 stems, 12 branches, 4 labels `年月日时`, 1 separator `·`) are
pre-rendered host-side with the project's existing Zpix pixel font
(`host/scripts/gen-ganzhi-font.mjs`, reusing the same font already used for
all other CJK text in `render/layout.js`) and baked into
`firmware/main/ganzhi_font.inc` as 24×24 1-bit bitmaps. Glyphs are centered
on their *actual ink bounding box* (`measureText`'s `actualBoundingBox*`
metrics), not a fixed baseline offset — an earlier version used a fixed
offset and silently clipped every glyph's bottom row against the canvas
edge (caught by `host/scripts/check-ganzhi-clip.mjs`, which asserts no
glyph touches the bitmap's edge, and confirmed on real hardware where e.g.
壬 rendered as 千 with its bottom stroke missing).

**Extending the covered date range.** The table currently covers roughly
2026-06 to 2031-09 (see the range in `gen-ganzhi-table.py`'s
`RANGE_START`/`RANGE_END`). Outside that range, `ganzhi_year_month` returns
false and the row is simply omitted (same "unknown → omit" pattern as
`--:--`) — it does not show garbage. Extend the range and re-run the
generator well before 2031.

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
- The ganzhi row's southern-hemisphere adjustment and timezone
  (`Pacific/Auckland`) are baked into the generated table at build time, not
  configurable at runtime — re-run `gen-ganzhi-table.py` with different
  settings if the device moves to a different hemisphere/timezone long-term.
- The table only covers a fixed multi-year range (see above); outside it,
  the ganzhi row is silently omitted rather than shown incorrectly.
