# Handoff — picking this up on the other machine

Rolling note between the home PC and the work PC. Both push to the same fork;
`git pull` is the whole sync. Last updated 2026-07-28 (morning, work PC).

## Per-machine setup that git does NOT carry

These are deliberately untracked, so a fresh clone needs them done once:

| File | Why it's untracked | What to do |
|---|---|---|
| `firmware/main/wifi_creds.h` | WPA passphrases in a public repo | `cp wifi_creds.h.example wifi_creds.h`, list **every** network — see below |
| `host/config.json` | owner's name/location/volume | already set on both machines; `name` is the **owner's name only** (`Hughie`), the panel composes `名字的物种` itself |
| `host/out/state.json` | the save file | now synced — see "one buddy" below |
| `start-buddy.vbs` | absolute paths | autostart launcher, per machine |

## wifi_creds.h holds BOTH networks, always

One firmware image serves home and work: the device cycles through every entry
in `WIFI_CREDS` on each disconnect. **Never flash a build that lists only the
network you happen to be standing in** — that is how the work network got
overwritten by the home one on 2026-07-27, and the symptom (device stuck on the
local-clock screen, KEY apparently doing nothing) reads as a broken button
rather than a missing SSID.

Both networks are in the file as of 2026-07-28 and the work PC's build was
verified to contain both before flashing. Verification recipe is in
`docs/wifi.md`; the `idf.py reconfigure` trap is documented there too.

## One buddy, synced (`docs/save-sync.md`)

`host/out/state.json` is still gitignored, but the host now syncs it through a
separate **private** repo (`Hugh1ezy/cpb-save`, added as the `save` remote), so
the buddy follows the device between machines instead of each machine raising
its own.

The rule: **only a host with the device actually attached publishes.** A host
idling in mock mode still ticks and accrues, and that drift is discarded — it
re-pulls the moment the device turns up.

Home PC needs two one-time steps (nothing else; the code arrives with `git pull`):

```powershell
cd "$HOME\claude-pokemon-buddy"
git remote add save https://github.com/Hugh1ezy/cpb-save.git
# then add the saveSync block from docs/save-sync.md to host/config.json
cd host
node scripts/save-sync-cli.mjs status   # shows local vs remote
node scripts/save-sync-cli.mjs pull     # ⚠ replaces the home save
```

⚠️ **That pull discards the home buddy.** As of 2026-07-27 evening home was
Bulbasaur Lv.2 / streak 2, and the synced save (published from the work PC on
2026-07-28) is Bulbasaur Lv.9 / streak 3. Only one survives. If the home one is
the one you actually want, `push` from home *before* the work host next runs
with the device attached, instead of pulling.

The save that a pull is about to replace is copied to `state.json.presync`
first, which is the one-step undo — and deliberately not `.bak`, since
`loadState` falls back to that one.

## State of play

Working on the home device right now:

- Firmware built and flashed from `main` — local-clock mode, ganzhi row,
  segmented battery, WiFi/mDNS transport all present.
- Host runs from `start-buddy.vbs` at logon, holds COM3, ~60s tick.
- Level curve runs to Lv.100; starters evolve on the official level gates
  (16/32 Bulbasaur, 16/36 Charmander and Squirtle).
- 亲密度 is daily now: ten hourly slots in one window a day, half a heart each,
  KEY-gated on working days and automatic at the weekend. Half a heart is also
  worth half a percent of the level in progress.

Not working, with the reason:

- **WEEK usage bar shows `--`.** The official percentages only arrive through
  the Claude Code statusline bridge (`~/.claude/settings.json` → `statusLine`,
  already configured here). It loads at session start, so it needs a **freshly
  opened** terminal session; this machine also has no `~/.claude/.credentials.json`,
  so the host's own poll path (`pollUsage failed: no-token`) can't work at all.
  Deriving a percentage from ccusage tokens was tried and reverted — cache-read
  tokens run orders of magnitude above quota, so every estimate pegged at 100%.
## WiFi: now proven end to end (2026-07-28, work PC)

The untested-on-battery path from the last note has been exercised. Device on
the work network takes `192.168.1.138`, advertises `_cpb._tcp.local`, listens on
tcp/7311; the host discovers it by mDNS, `T_AUTH` is accepted and frames are
ACKed with the USB cable out. Home was `192.168.1.114` on the same firmware.

Measured, so nobody re-debugs this as "the switch back is broken":

| | |
|---|---|
| host cold start → first frame on the panel | **4.5 s** |
| push rate while the host is up | every **333 ms** (the buddy animator, not the 60 s tick) |
| device leaves local-clock mode | on the **first frame** — no timer, no button needed |
| device enters local-clock mode | after **120 s** with no frame on either link |

So "it won't switch back to the networked screen" is almost never the device.
It means no frames are arriving, and the usual reason is that the **host is not
running**: `start-buddy.vbs` lives in the Startup folder, which fires **only at
logon**. The work PC had not rebooted since 2026-07-16 while the entry was added
on 07-27, so it had never once run. Check that before touching firmware.

`host/out/wifi-probe.mjs` (untracked, work PC) talks the protocol directly over
TCP — mDNS discovery, `T_AUTH`, one full-screen frame, and it prints the ACK.
It answers "is the link or the device at fault" in one command, without USB.
Stop the host first: the device accepts one client at a time.

## Test suite on Windows

`npm test` in `host/` fails 9 tests on any Windows machine — macOS launchd plist
builders, a `ps`-based process matcher, a `species_cries.inc` regeneration check
that needs python, and two statusline fan-out tests that need `sh`. A tenth,
`quiet boundary ... (RM12)`, is a genuine 500ms race that fails maybe one run in
four on both clean and modified trees. Everything else should pass; treat any
other failure as real.

Baseline on the work PC, 2026-07-28: **477 pass / 9 fail** out of 486, and the 9
are exactly that documented set.

## Toolchain

ESP-IDF v5.4 is installed at `~/esp/esp-idf` on the home machine (shallow clone
plus `install.ps1 esp32s3`). Each new shell needs `. "$HOME\esp\esp-idf\export.ps1"`
before `idf.py` works. Build and flash: `idf.py -C firmware -p COM3 flash`.
