# Handoff — picking this up on the other machine, or in a fresh session

Rolling note between the home PC and the work PC. Last updated **2026-07-28
(late evening, HOME PC)**, at the end of a session that took the save handoff
live on the home machine and wired the encounter engine into the tick. Earlier
the same day, on the work PC: the first three phases of the 151-species pokedex
work. Before that: the wake latency, the weekday 亲密度 payout, the half-heart
rendering, and save syncing itself.

Three remotes now:

| Remote | What |
|---|---|
| `origin` | `Hugh1ezy/claude-pokemon-buddy` — the fork, **public**, code lives here |
| `upstream` | `aquamarinz/claude-pokemon-buddy` — original, read-only |
| `save` | `Hugh1ezy/cpb-save` — **private**, holds only `state.json` (`docs/save-sync.md`) |

Buddy as of this note: **妙蛙种子 (bulbasaur) Lv.9, bond 10.4, streak 3,
bondHalves 7**, published to `save` from the home PC on the evening of 07-28.
The home PC's setup is now complete and its host is running.

---

## ▶ What the WORK PC has to do, in order

```powershell
cd "$HOME\claude-pokemon-buddy"
git pull
cd host
node scripts/save-sync-cli.mjs status   # local vs remote, no writes
node scripts/save-sync-cli.mjs pull     # ⚠ replaces the local save
```

1. **Take the synced save.** The device spent the evening on the home PC, which
   published on every meaningful change and again on shutdown — so `pull` is the
   right direction and `push` is not. The replaced file lands at
   `state.json.presync` as a one-step undo.
2. **Restart the host** so it picks up the pulled code. Nothing else: the work
   PC already has its sprites baked, its `config.json`, and its `wifi_creds.h`.
3. **No reflash.** Nothing in this session touched `firmware/`.

If `status` shows the remote *behind* what is on this machine, stop and read
"the two-buddy trap" below before running anything.

---

## Session record: 2026-07-28 evening, home PC

### The save handoff now actually works on the home machine

It did not before, and the way it failed was silent. `save-sync.js` shells out
to `git commit-tree`, and **the home repo had no `user.name`/`user.email` set —
neither local nor global**. Every publish died with `commit-tree-failed --
Author identity unknown`, logged once per attempt into
`out/host-autostart.log` and nowhere the owner would look. 32 failed publishes
before it was spotted. Fixed with repo-local config:

```powershell
git config user.name "Hugh1ezy"
git config user.email "zy94807@gmail.com"
```

**This is now a per-machine setup item** (added to the table below). The work PC
has an identity already — that is why publishing worked from there and the
asymmetry went unnoticed. Anywhere this repo is cloned fresh, check it: the
symptom is a buddy that quietly stops travelling, with the evidence buried in a
log.

### The two-buddy trap, and how it got resolved

The home PC had been raising its **own** buddy — same species and level by
coincidence, but different IVs (`[16,26,23,22,12,18]` vs `[0,1,20,5,0,13]`),
different nature (急性子 vs 慢性子). It was superseded by the `pull` and is
kept at `host/out/state.json.presync` on the home machine. The one everybody
means is the one on the `save` remote.

That is what the pull direction is guarding. `status` before `pull`, every time.

### Encounters are wired into the tick (P4, steps 1-4)

See the P4 section below. The engine had been written and never called;
it is called now.

### A `save` branch briefly existed on the PUBLIC fork — it is gone

Pushed there by mistake before `docs/save-sync.md` was read, deleted the same
evening. `git ls-remote origin` should show `main` and two tags, nothing else.
If a stale clone shows `origin/save`, it is dead — prune it. The save belongs on
the private `save` remote and nowhere else; the fork is public.

### A full backup of the home PC exists

`C:\Users\GENAPC\cpb-backup-2026-07-28-2229\` — the whole working directory
including `.git/`, `node_modules/` and the baked sprites (2670 files, verified
by count and by restoring it to a scratch directory and running the tests from
the copy), plus an all-refs git bundle and the five untracked per-machine files
on their own. `README.md` in there has the rollback commands. It holds WPA
passphrases and the pairing token, so it stays local — not in the repo, not in a
cloud folder.

Also on the home machine: a dead local branch
`claude/duplicate-save-sync-2026-07-28`, a save-sync implementation written
before this repo's own was discovered. Never pushed. Safe to delete.

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
| P4 notification row + capture screen | **half done (2026-07-28, home PC)** — the engine is wired into the tick and encounters now really happen and persist; nothing is drawn yet. See below |
| P5 pokedex screen + swapping the active buddy | not started |
| P6 real cries | not started — waiting on a microSD card the owner does not have yet |

### P4, where it actually stands

The invisible half is in. `encounter.js` had been written but never called by
anything — the engine existed and could not fire. Now:

- `pet/encounter-table.js` loads `seed/encounters.json` at runtime, once. It
  never logs, prints or summarises what it read, and its error messages quote
  nothing from the file — a JSON parse error prints the offending text, and here
  that text is content the owner asked not to see.
- `pet/encounter-context.js` assembles the ctx from what the tick already holds.
  The rule is **absent, not guessed**: an unknown reading is `null`, never `0`,
  because `0` silently satisfies every `atLeast` condition and defeats every
  `Below` one.
- `weather.js` now resolves a coarse `kind` (`sun`/`rain`/`fog`) from the WMO
  code alongside the Chinese `cond`. It is resolved at the code, not parsed back
  out of the label, so rewording the panel cannot silently change which species
  are eligible. Codes outside those three deliberately give `kind: null`.
- `species-meta.js` gained `evolutionRoot()`. The save records only the CURRENT
  species, so a twice-evolved buddy has no memory of what hatched; the
  "not the one you chose" condition needs it, and walking `evolvesFrom` back to
  the root answers it without adding a save field.
- `index.js`'s `applyEncounterTick()` runs last in the tick, after any evolution,
  and records the buddy's own line in the dex (`recordSeen`) — the starter line
  is excluded from the wild on purpose, so this is the only way those entries
  can ever light up.
- The offer survives a restart: `state.js` salvages `encounter`, but never
  repairs it. An offer with no `offeredAt` is dropped and the cooldown kept,
  because nothing could ever expire it and it would sit on the panel forever.

A save that has never seen an encounter still round-trips byte-identical, so
save-sync has nothing new to publish until something actually happens.

**What is left is all of the visible half**: the row 3 notification, the capture
screen, and the button that answers it. Nothing draws an encounter yet, so today
they appear in the save and the log and nowhere else.

One stale comment worth knowing about: `ENCOUNTER_DEFAULTS.perTickChance` is
`0.0065`, but the comment above it still describes `0.0028` and "near 2.5 a day".
The handoff's measured figure is ~4.7/day, so the value is current and the
comment is not — left alone rather than guessed at, since the number comes from
`sim-encounters.mjs` and that is a spoiler file.

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
| **git `user.name` / `user.email`** | not a file, but git does not carry it either | **required for save-sync to publish at all.** `git commit-tree` refuses without an identity and the failure only shows up in `out/host-autostart.log`. Set it repo-local; see the 07-28 session record above |
| `host/seed/sprites/`, `host/seed/oak.png` | Nintendo artwork, public repo | **new 2026-07-28** — run `cd host && node scripts/bake-assets.mjs` once per machine (~156 files, a few minutes). Without it the buddy renders as a checkerboard placeholder and the sprite tests skip themselves. |

### Do not "optimise" the animator pause in the tick loop

`index.js`'s tick holds `animator.pause()` across the usage and weather I/O —
about three seconds of `npx ccusage` plus a network fetch — and it looks like
pure dead time on the wake path. It is not. It is load-shedding.

After a wake `previousBytes` is null, so **every** push is a full ~9.4KB frame
instead of a small dirty rect. Narrowing the pause to just the render lets the
animator fire into that at 3Hz on top of the tick's own frame; the device stops
acknowledging frames altogether and the panel never comes back at all. This was
tried on 2026-07-28, made the switch-back worse than the problem it was aimed
at, and was reverted along with the firmware built alongside it.

The real fix, when someone gets to it, is upstream of the pause: coalesce
queued pushes so only the newest frame is ever in flight, instead of sending
stale frames one by one while newer ones wait behind them. Do that first, then
the pause can be narrowed safely.

More generally: the wake path was tuned across two full sessions and is the
thing the owner notices most. Measure before changing it, and change it on its
own, not as a side quest inside unrelated feature work.

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
needs python, and two statusline fan-out tests that need `sh`. Two more are
races that depend on how loaded the machine is.

Measured baselines, all 2026-07-28, to be diffed against rather than
re-derived:

| Run | Result | Exited? |
|---|---|---|
| Work PC, `7d2b799` | 491 pass / 10 fail of 501 | yes |
| Home PC, `7d2b799` (clean) | 506 pass / **12** fail of 518 | **no — killed at 780 s** |
| Home PC, `7d2b799` + P4 | 520 pass / 10 fail of 530 | yes |

The steady 10 are the 9 platform failures plus the RM12 flake. **Two more are
load-dependent** and appear only sometimes on the home PC:

- `main logs pollUsage failures once per reason transition`
- `main resolves when SIGINT stops the loop during its sleep (RH2)`

Both pass when `main-orchestration.test.js` runs on its own, and fail under
`--test-concurrency=4` on a machine slow enough to lose the race. Anything
outside these twelve is real.

### …and sometimes `npm test` will not exit

Some runs print a complete summary and then **hang instead of exiting**, needing
a kill by hand. The stuck process is always `main-orchestration.test.js`'s
child, always *after* all 13 of its tests have reported — a process that will
not exit, not a test that will not finish.

**Do not chase it as a regression in whatever you just wrote.** It was measured
against a clean tree specifically to answer that, and it hangs there too.

What the three runs above say about the cause, which is more than was known
before: **the hang tracks those two load-dependent failures, not RM12.** The run
that hung failed both of them; the run that exited cleanly passed both — and
RM12 failed in *both* runs, so RM12 is not it. The mechanism to look at first is
therefore whichever of those two leaves `main()`'s promise pending when it loses
its race, e.g.

```js
const result = await Promise.race([running.then(() => "settled"), sleep(500).then(() => "timeout")]);
```

where `running` is `main()`: when the timeout arm wins, the assertion fails but
that promise is still pending, holding the tick loop, its timer and the
transport alive behind it. Unconfirmed, but the correlation is measured.

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
