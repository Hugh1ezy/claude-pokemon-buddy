# Handoff — picking this up on the other machine

Rolling note between the home PC and the work PC. Both push to the same fork;
`git pull` is the whole sync. Last updated 2026-07-27 (evening, home PC).

## Per-machine setup that git does NOT carry

These are deliberately untracked, so a fresh clone needs them done once:

| File | Why it's untracked | What to do |
|---|---|---|
| `firmware/main/wifi_creds.h` | WPA passphrases in a public repo | `cp wifi_creds.h.example wifi_creds.h`, fill in that machine's networks |
| `host/config.json` | owner's name/location/volume | already set on both machines; `name` is the **owner's name only** (`Hughie`), the panel composes `名字的物种` itself |
| `host/out/state.json` | the save file | see "two buddies" below |
| `start-buddy.vbs` | absolute paths | autostart launcher, per machine |

## Two buddies, one repo

The save lives in `host/out/state.json`, which is machine-local. Home and work
each raise their own buddy and git will never merge them. If that is not what
you want, run the host on one machine only and let the other be code-editing.

Home buddy as of this note: Bulbasaur, Lv.2, streak 2 days.

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
**WiFi is live on the home network** as of 2026-07-28 00:10: the device joined,
took `192.168.1.114`, advertises `cpb-buddy.local` and listens on tcp/7311.
`host/config.json` has its `wifi` block (`enabled` + the pairing token). Pulling
the USB cable should now fall back to WiFi instead of stranding the device in
local-clock mode — untested end to end, since it needs someone to unplug it.

When adding the work network to `wifi_creds.h`, note the trap that cost a
reflash here: **creating that file for the first time needs `idf.py reconfigure`**
before `idf.py flash`. Verify before believing the flash:

```powershell
$t = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes("firmware/build/pokemon_buddy_fw.bin"))
$t.Contains("YOUR_SSID")   # must be True
```

## Test suite on Windows

`npm test` in `host/` fails 9 tests on any Windows machine — macOS launchd plist
builders, a `ps`-based process matcher, a `species_cries.inc` regeneration check
that needs python, and two statusline fan-out tests that need `sh`. A tenth,
`quiet boundary ... (RM12)`, is a genuine 500ms race that fails maybe one run in
four on both clean and modified trees. Everything else should pass; treat any
other failure as real.

## Toolchain

ESP-IDF v5.4 is installed at `~/esp/esp-idf` on the home machine (shallow clone
plus `install.ps1 esp32s3`). Each new shell needs `. "$HOME\esp\esp-idf\export.ps1"`
before `idf.py` works. Build and flash: `idf.py -C firmware -p COM3 flash`.
