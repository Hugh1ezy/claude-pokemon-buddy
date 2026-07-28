# Handoff — picking this up on the other machine, or in a fresh session

Rolling note between the home PC and the work PC. Last updated **2026-07-28
(evening, work PC)**, at the end of a session that built the first three
phases of the 151-species pokedex work. The session before it, earlier the
same day, is the one that fixed the wake latency, the weekday 亲密度 payout,
the half-heart rendering, and added save syncing.

Three remotes now:

| Remote | What |
|---|---|
| `origin` | `Hugh1ezy/claude-pokemon-buddy` — the fork, **public**, code lives here |
| `upstream` | `aquamarinz/claude-pokemon-buddy` — original, read-only |
| `save` | `Hugh1ezy/cpb-save` — **private**, holds only `state.json` (`docs/save-sync.md`) |

Buddy as of this note: **妙蛙种子 (bulbasaur) Lv.9, streak 3**, pushed to `save`
and current as of the device leaving the work PC.

---

## ▶ What the HOME PC has to do, in order

```powershell
cd "$HOME\claude-pokemon-buddy"
git pull
cd host
node scripts/save-sync-cli.mjs status   # local vs remote
node scripts/save-sync-cli.mjs pull     # ⚠ replaces the local save
node scripts/bake-assets.mjs            # NEW, required -- see below
```

1. **Take the synced save.** The work PC published it before the device left,
   so `pull` is the right direction. The replaced file is copied to
   `state.json.presync` as a one-step undo (deliberately not `.bak`, which
   `loadState` falls back to). Do **not** `push` from home first — that would
   overwrite the buddy the device has actually been living on all day.
2. **Bake the sprites.** `seed/sprites/` and `seed/oak.png` are gitignored as
   of this session (Nintendo artwork, public repo), so a pull brings the baker
   and not the images. It takes a few minutes and writes 156 files. Skipping it
   is not fatal — the buddy renders as a checkerboard placeholder and the
   sprite tests skip themselves with a message pointing back here — but nothing
   looks right until it is done.
3. **No reflash needed.** The firmware on the device is built from this
   commit's `firmware/` tree, flashed and verified on the work PC on 07-28.
   Nothing in this session changed it.
4. Restart the host so it picks up the new host-side code.

`host/config.json` and its `saveSync` block already exist on both machines as
of 07-28; only re-add them if the file has gone missing (contents in
`docs/save-sync.md`).

---

## The 151-species pokedex work — where it stands

Three phases are in and green; the rest is not started. Everything so far is
host-side and additive: no firmware change, no change to the wake path, the
transport, or the animator. The device is running exactly what it ran before.

| Phase | State |
|---|---|
| P1 metadata + sprites | **done** — `seed/pokedex.json` (names/types/evolutions/capture rates for 1–151), 156 baked sprites, `species-meta.js` sources all of it |
| P2 save model | **done** — `pet/dex.js`: 已捕获 count (duplicates included), pokedex count (distinct), and a box holding one pet per species, each with its own level and bond |
| P3 encounter engine | **done** — `pet/encounter.js` + a generated condition table |
| P4 notification row + capture screen | not started — this is the next thing |
| P5 pokedex screen + swapping the active buddy | not started |
| P6 real cries | not started — waiting on a microSD card the owner does not have yet |

### Two things to know before touching any of it

**The save schema version was deliberately NOT bumped.** `loadState` accepts a
save only on an exact `schemaVersion` match and otherwise falls back to a
whitelist salvage that drops what it does not recognise. Bumping it would make
any machine still running older code strip the pokedex out of a current save
and push the stripped copy back through save-sync, silently. The new fields are
purely additive and old code carries them through untouched — there is a test
pinning that property (`test/dex.test.js`, "an unrecognised field is carried
through load and save untouched"). Bump the version when a field changes
**meaning**, not when one is added.

**Three files are spoilers and the owner has asked not to see them:**
`host/scripts/gen-encounters.mjs`, `host/seed/encounters.json`, and
`host/scripts/sim-encounters.mjs` (its output names species). They hold which
of the 151 appears under which conditions. The runtime engine
(`src/pet/encounter.js`) is deliberately free of species knowledge so it can be
read and reviewed without giving anything away, and the tests use invented
conditions on arbitrary species for the same reason. Keep it that way: no
species-condition pairs in chat, in commit messages, in this file, or in test
names.

Pacing is measured, not guessed: `sim-encounters.mjs` runs the real engine over
a simulated year on the owner's actual routine and Auckland's actual weather.
40/40 runs complete the dex, median 331 days (~11 months), ~4.7 encounters a
day. Re-run it after changing any weight or condition — the first version of
the table looked reasonable and left 16 species unreachable, which only the
simulation caught.

---

## Per-machine setup that git does NOT carry

| File | Why untracked | Notes |
|---|---|---|
| `firmware/main/wifi_creds.h` | WPA passphrases, public repo | must list **every** network — see below |
| `host/config.json` | name/location/volume/token/saveSync | `name` is the **owner's name only** (`Hughie`); the panel composes 名字的物种 itself |
| `host/out/state.json` | the save | synced now, see `docs/save-sync.md` |
| `start-buddy.vbs` | absolute paths | autostart launcher |
| `host/seed/sprites/`, `host/seed/oak.png` | Nintendo artwork, public repo | **new 2026-07-28** — run `cd host && node scripts/bake-assets.mjs` once per machine (~156 files, a few minutes). Without it the buddy renders as a checkerboard placeholder and the sprite tests skip themselves. |

### wifi_creds.h holds BOTH networks, always

One image serves home and work. **Never flash a build listing only the network
you are standing in** — that is how the work network got dropped on 07-27, and
the symptom (device stuck on the clock screen, button apparently dead) reads as
broken hardware rather than a missing SSID. Verification recipe and the
`idf.py reconfigure` trap are in `docs/wifi.md`.

---

## One buddy, synced (`docs/save-sync.md`)

`host/out/state.json` stays gitignored; the host syncs it through the private
`save` remote. The rule is **whoever holds the device owns the save**:

- Device attaches to a host → that host **pulls** first.
- Only a host with a device attached **publishes**. A host idling in mock mode
  keeps ticking and accruing, and that drift is deliberately discarded.
- Device **detaches** → publish immediately, not on the 5-minute debounce. That
  is the handoff: leaving for the day must not strand the last few minutes.
- A pull will not roll back over a tip this machine itself published (the miss
  is tracked in `state.json.sync`), because reseating a USB cable is a detach
  and re-attach and would otherwise revert an hour's bond credit.

---

## WiFi and the "it won't switch back" problem

`_cpb._tcp.local` on tcp/7311. Work: `192.168.1.138`. Home: `192.168.1.114`.

Measured on the work PC, 2026-07-28. **These are four different questions and
conflating them cost most of an afternoon** — measure the one you actually mean:

| | |
|---|---|
| USB unplug → running on wifi | **1.4 s** (was 15-18 s) |
| host cold start → device leaves the clock face | **2.8 s** (was 6.9 s) |
| power-save wake, device side | **657 ms** (was 3743 ms) |
| cold boot → on the network | **12.8 s** — untouched, see below |
| push rate while the host is up | every **333 ms** (the animator, not the 60 s tick) |
| device leaves local-clock mode | on the **first frame**, no timer, no button |
| device enters local-clock mode | after **120 s** with no frame on either link |

What actually fixed each, since none of it was where it looked:

1. **The host was not running at all.** `start-buddy.vbs` is in the Startup
   folder, which fires **only at logon**. The work PC had not rebooted since
   07-16 while the entry was added on 07-27 — it had never once run. Check this
   before touching anything else.
2. **A KEY double-click had silently stopped the radio.** Manual local-clock
   mode called `esp_wifi_stop()` with nothing on screen to say so, and the
   disconnect handler then tried to reconnect a stopped radio — which fails
   without raising another event, killing the retry loop permanently. Power-save
   now lives entirely on **BOOT** (`docs/local-clock-mode.md`) so KEY is purely
   the buddy's, and the handler ignores disconnects it caused itself.
3. **Reconnect cycled to the *other* credential first**, guaranteeing a failed
   association against a network that is not in range plus the cycle backoff.
   The credential that last earned an IP is now retried before the cycle moves.
4. **The host burned 4 s browsing mDNS on every failed probe** while the device
   was merely still booting. Now: remembered address first (400 ms), escalate to
   a browse only after 8 consecutive misses, and that browse gets 1.5 s.
5. **DHCP was 3.1 s of the 3.7 s device-side wake.** Association is 63-630 ms;
   scanning was never the problem. The lease is kept alongside the BSSID pin and
   reapplied when rejoining the same AP, gated on that pin so moving between
   locations always runs DHCP normally.

**Cold boot is still 12.8 s** and is a different path: the first association
attempt fails (`reason=2`), the cycle tries the other location's SSID, then
eats the 5 s backoff before the attempt that works. Rarely hit — the device
normally stays powered — so it was left alone deliberately.

---

## Diagnostics: what works and what lies

**Probe the device with a TCP connect to 7311. Nothing else.**

| Method | Verdict |
|---|---|
| TCP connect to 7311 | ✅ the only reliable one. Note: one client at a time, so do not probe while the host should be connecting |
| ICMP / ping | ❌ dropped often enough to look like a dead device |
| mDNS browse from node | ❌ returned nothing for a device a TCP connect reached in 272 ms, and missed the device returning twice during a measurement |
| `ESP_LOG` over USB | ❌ **silently lost** — console output races with `usb_serial_jtag_driver_install` (CLAUDE.md 8.1). An attempt to read the wake path this way captured literally nothing |

The firmware has a `diag()` helper that writes through
`usb_serial_jtag_write_bytes` — the channel that does survive. Lines are
`#CPB <uptime_ms> <text>`, sharing the wire with the protocol (the host parser
skips them). It is what made the DHCP finding visible; leave it in.

Untracked helpers in `host/out/` on the work PC:

| Script | Does |
|---|---|
| `wifi-probe.mjs` | talks the protocol over TCP: discovery, `T_AUTH`, one full frame, prints the ACK. Answers "link or device?" without USB. Stop the host first |
| `serial-log.mjs` | timestamped reader for the `#CPB` diag lines. Host must not hold the port — but if it does not, the host has no transport, so start it over **wifi** by holding COM7 with this script and letting the host fall back |
| `wake-probe.mjs` | times device-return vs host-reconnect. Its mDNS detection is unreliable, see above — trust the owner's stopwatch over it |

---

## 亲密度

Hourly slots in one window a day, half a heart each, ten to a full five hearts.
Working days need a KEY press inside the hour; weekends pay out on their own.
Half a heart is also worth half a percent of the level in progress.

**Weekday payout was silently broken until 07-28**: a short KEY press is both
the greet gesture and the bond credit, and the dispatcher returned before
queueing the event, so `applyBondTick` never saw `clicked`. Two existing tests
had frozen that swallow into the contract by asserting `drainTickEvents()` was
empty. Verified on hardware after the fix.

The half-heart fill was also wrong — the clipped rect was sized against 8 while
the heart path spans 16, so "half" inked about 15% of the shape and read as a
sliver. `host/test/heart-fill.test.js` counts pixels, which is the only way that
class of bug shows up.

---

## Test suite on Windows

`npm test` in `host/` fails **9** tests on any Windows machine: macOS launchd
plist builders, a `ps`-based process matcher, a `species_cries.inc` check that
needs python, and two statusline fan-out tests that need `sh`. A tenth,
`quiet boundary … (RM12)`, is a genuine 500 ms race that fails perhaps one run
in four on clean and modified trees alike.

Baseline on the work PC, 2026-07-28: **491 pass / 10 fail out of 501**, the 10
being those 9 plus the RM12 flake. Treat any other failure as real.

---

## Traps that cost time today

- **Never round-trip a source file through PowerShell.** `Get-Content` reads as
  the ANSI codepage (GBK here); writing it back as UTF-8 turned every Chinese
  string in `layout.js` into mojibake and broke a quote, i.e. a syntax error.
  Use the editing tools, or `git checkout --` to recover.
- **Pass git commit messages with `-F <file>`.** A message containing double
  quotes gets torn apart when PowerShell hands it to git, and the failure mode
  is a *partial* commit — the previous `git add` still lands, under the wrong
  message. It happened twice.
- **`idf.py` needs `. "$HOME\esp\esp-idf\export.ps1"` in every new shell.**
  Shell state does not persist between tool calls.

## Toolchain

ESP-IDF v5.4 at `~/esp/esp-idf` on **both** machines. Work PC device is on
**COM7**; home PC was COM3.
