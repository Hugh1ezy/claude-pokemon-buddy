# Handoff — picking this up on the other machine, or in a fresh session

Rolling note between the home PC and the work PC. Last updated **2026-08-03
(evening, HOME PC — arrival sync done)**.

## ▶ 2026-08-03 evening, home PC — the arrival sync ran, in full

Everything the section below used to ask for is done. State as of **19:59**:

- `git pull hugh main` took the 8 commits of the work day. **`HEAD == hugh/main
  == 918cc9a`**, working tree clean, `main` already tracked `hugh/main` here.
- **The save needed nothing.** Both copies read `Lv.5 exp=0.07 bond=0.4
  streak=8 图鉴=16 捕捉=14 box=13` before and after — the work PC's departure
  push had already landed. `already the same save, nothing to do`.
- **Host restarted onto the new code** (pid 5416, 19:59:43) via
  `start-buddy.vbs`. No `npm install` was needed: the only dependency added
  today is a **devDependency** used by `bake-cries.mjs`, not by the tick.
- **The device is attached over serial.** COM3 is present and the new process
  connected on its *initial* probe — so there is deliberately no `ESP serial
  device detected; upgrading mock transport` line for it. That line means the
  host started on mock and upgraded later; its absence together with no `ESP
  serial port not found` is the healthy signature. The pre-restart process had
  both, because it started before the device came home.

Two consequences worth carrying to work tomorrow:

1. **The device is home and attached, so this machine owns the save tonight** —
   the work PC's direction in the morning is `pull`.
2. **Nothing is waiting to evolve.** Measured against the new table with the
   real save: 14 members between panel and box, **0** of them past a level line,
   and `readyToEvolve=false`. So if the evolution work looks silent tomorrow,
   that is not evidence it is broken — nothing is eligible yet.

Still true and still unverified: **browsing the pokedex may make one constant
sound**, because the firmware plays the buddy's cry on every KEY short no matter
what screen the host is holding. Fixing it is a protocol change plus a reflash.
Listening for it is a hardware check only the owner can do.

`pollUsage failed: no-token` still repeats every tick on this machine. It
predates all of this and only costs the usage rows.

## ▶ What the HOME PC had to do tonight — ✅ done 2026-08-03 19:59

The device left work at **18:1x on 08-03**. The save was published and both
copies matched at that moment; the host there was then **stopped**, so nothing
on the work machine ticked overnight.

```powershell
cd "$HOME\claude-pokemon-buddy"
git fetch hugh; git log --oneline HEAD..hugh/main; git pull hugh main
cd host
node scripts/save-sync-cli.mjs status     # now prints 图鉴/捕捉/box too
node scripts/save-sync-cli.mjs pull       # once the device is actually home
```

Then **restart the host** — a great deal of tick-facing code changed today.
**No reflash**: the device is carrying an image flashed from the work machine at
13:17 today. **No re-bake** of sprites.

**Run `node scripts/bake-cries.mjs` once on that machine** if you want the real
cries there — `host/seed/cries/` is gitignored Nintendo audio, same rule as the
sprites, so git does not carry it. Nothing on the device uses it yet. **Not run
on the home PC tonight** — the owner has not asked for cries here.

Three things worth doing at home tonight:

1. **Check what browsing the pokedex sounds like now.** The host no longer cries
   on cursor moves — only on the zoom. There is a prediction attached to that
   (below) which has NOT been checked on hardware: the firmware plays the
   buddy's own cry locally on every KEY short regardless of what screen is up,
   so browsing may still make one constant sound.
2. **Watch for an evolution.** 63 species could not evolve at all until today.
   If anything in the box is sitting past its level, it will offer now.
   — *checked: nothing is eligible, see above.*
3. If the panel looks wrong in any way, check the host's **start time** before
   checking the code. That has been the answer three times this week.

## ▶ 2026-08-03 afternoon, work PC — evolution, and where the cry goes

### 63 of the 70 species that can evolve simply never did

The owner reported it from the player's end: his buddy reached the level its
species evolves at and nothing happened. `evolution.js` returns no branches for a
species with no entry, and `seed/evolution/` held **four hand-authored lines**.
Not a broken rule — missing data. **His four files' six level conditions were
canonical, every one.**

`scripts/gen-evolution.mjs` now generates the table from PokeAPI. It accepts only
triggers Generation 1 actually had — a level-up with a `min_level`, and the five
Gen-1 stones — and drops everything else, because **PokeAPI reports each link the
way the LATEST generation implements it**. Taken literally it serves an ice-stone
link, a galarica-cuff link and a happiness link for species inside the 151, which
would have quietly imported three later-generation systems into a Gen-1 game.

Measured through the real loader afterwards: **70 of 70** species that can evolve
now have branches, 72 targets inside the 151, and the four hand-authored files
are untouched.

**`evolution.js` merges per species now instead of `Object.assign`.** Two files
may legitimately describe the same species, and whole-node replacement made the
winner depend on readdir order — a branch silently not existing, which is exactly
the failure this directory had already produced once by being incomplete.

### The wild pool moved, on the owner's instruction

He asked for the encounter weights to be regenerated in the same pass. Measured:
**115 species can still be met in the wild, 36 are evolution-only, 0 are stranded,
and all 151 remain obtainable by some route.** An earlier estimate in this
session put the exclusion as high as 72; that was the theoretical ceiling and the
real number is 36.

> `sim-encounters.mjs` still does not model evolution, so it cannot confirm the
> dex is completable in a reasonable time. The count above proves every species is
> *reachable*, not that the whole set is *achievable*. That guard is still owed.

### Evolving into a species you already own

The owner defined this himself when he asked what would happen:

- **捕捉 does not move** — an evolution is not a capture.
- **图鉴 +1** if the new form was not already lit.
- **The higher-level one survives**; a tie keeps the one that just evolved, since
  it is the one on the panel whose nature the owner has been looking at.
- **No boxed copy of that species is left behind.** Panel-and-box for one species
  is the state that must not exist: `rosterEntries` renders one and strands the
  other, which from outside looks like a pokemon that lost its levels.

Eight tests in `test/evolve-into-owned.test.js`. It fired for real the same
afternoon: 图鉴 14 → 15, 捕捉 unchanged at 13.

### The pokedex cry moved from the cursor to the zoom

Owner, after living with it the other way round. Browsing is one press per
species, so a cry per press queues them up behind a blocking codec write and the
sound stops corresponding to the row under the cursor. The zoom is the deliberate
"show me this one" and gets the sound to itself. Fires on the *transition* into
the confirm view, so a repaint is silent; cancel, page-turn and confirm are all
silent.

> **Predicted, NOT verified on hardware:** browsing may still make one constant
> sound. `on_key_single` in `main.cpp` plays `g_active_cry` on every KEY short and
> the device has no idea a host screen is up — only the capture BGM suppresses it
> (`g_bgm_active`). Silencing it needs the same treatment: a "host holds the
> screen" flag, which is a protocol change and a reflash. Not done.

### Real Game Boy cries are baked, and nothing on the device uses them yet

`scripts/bake-cries.mjs` fetches the **legacy** cries from PokeAPI — despite the
extension, `latest/*.ogg` is an MP3 of the modern remaster; `legacy/*.ogg` is real
Ogg Vorbis of the Game Boy original — and writes 16 kHz mono s16le to
`seed/cries/`. **138 baked, 181..2238 ms, 3.48 MB total.** The 18 hand-authored
cries are deliberately excluded: the owner asked for those to stay.

`seed/cries/` is **gitignored**, same rule and same reason as `seed/sprites/`.
Verified: git sees the script and not the 3.48 MB.

`--wav` also writes `seed/cries/audition.html`, a local page with a player per
cry and a checkbox that produces a list of ids. It plays Nintendo audio, so it is
`file://` only — never publish it.

**The device half is not started.** It needs a file-transfer frame, firmware that
writes to the SD card, and a play path that streams from the card and falls back
to the synthesized cry when a file is absent. That fallback is the safety belt:
it makes the rollout incremental. **Neither PC has a card reader** (checked on
both), so streaming over the wire is the only route, not a preference.

### The test suite intermittently does not exit, and it is not new

`npm test` sometimes hangs after every test has finished — a leaked handle, not a
stuck test. **Reproduced on a clean tree with all of the day's changes stashed**,
so it predates them. `--test-force-exit` makes it deterministic (the whole suite
in a few seconds).

Numbers for comparison, all with `--test-force-exit --test-concurrency=4`:
clean-tree control **12 failures**, end of day **13**, and the extra one is RM12,
which flipped pass/fail across three identical runs. The standing Windows set is
launchd/plist ×6, the two `.inc` no-drift tests that want python, and the
statusline fan-out pair.

> Time was lost here: several bisects were run against this file before noticing
> the behaviour was intermittent, which is why they contradicted each other.
> Establish whether a symptom is stable **before** bisecting it.

## ▶ Read this first: the save-sync guards were never running

**2026-08-03, work PC.** A weekend of play was overwritten and recovered. The
short version, because it changes how much you can trust anything this file says
about save sync working:

`transport.getKind()` returns the **string `"mock"`** when nothing is attached,
and every save-sync guard asked "is the device here?" as
`Boolean(transport.getKind())`. That is `true` for `"mock"`. So, since the day
the guard landed:

- the pull-on-arrival fired **once**, on the first tick after a host start, and
  never again — a device arriving at an already-running host never triggered it;
- the push-on-departure branch was **dead code**, unreachable in both directions;
- "publish only from the machine holding the device", called *the whole safety
  story* in `save-sync.js`'s own header, was an **unconditional yes**. A host
  idling in mock mode published exactly as if it held the device.

What that cost: this machine's host had been up since **07-31 14:27** and never
stopped when the device went home. The home PC published its weekend at
**08-02 22:26** (`34fe9bd`: Lv.11, 图鉴 14, 捕捉 13, box 12) and was then shut
down. At **08-03 11:09:58** the three-day-old host here force-pushed its stale
save (`c8c1d68`: Lv.5, 图鉴 5, 捕捉 4, box 3) over it. The owner noticed because
图鉴 and 捕捉 read wrong; the **level did not** — the stale lineage had settled
to Lv.11 that morning by coincidence, the same number the real save carried.

**`--force-with-lease` did not help and structurally cannot.** `push()` fetches
the tip and pins the lease to what it fetched milliseconds earlier, so it only
ever catches a genuine race. It was satisfied throughout. The header comment
claiming it protects against the other machine having pushed has been corrected.

### Recovery, and where the originals are

`34fe9bd` survived only in this machine's `refs/remotes/save/main` **reflog** —
the save branch is one parentless commit deep, so the overwritten commit is
unreachable on the remote the moment it is replaced. `git reflog show
refs/remotes/save/main` is the recovery path, and it is worth knowing before you
need it.

Byte-exact copies kept outside the repo at `~/cpb-save-recovery-2026-08-03/`
(`state-34fe9bd-exact.json` is the one that matters). The save displaced by the
restore is at `host/out/state.json.prerestore-2026-08-03`. Extract blobs with
`git cat-file blob` **through node**, not a PowerShell pipeline — `Out-File`
added a BOM and a trailing newline and the copy was no longer byte-exact.

### What changed, and what is still only argued

Four fixes, `npm test` 675 tests / 664 pass / **11 fail, byte-identical to the
pre-change baseline on this machine** (measured by stashing and re-running, not
assumed). The 11 are the standing Windows failures: launchd/plist ×6, the two
`.inc` no-drift tests that need python, the statusline fan-out pair, and the
RM12 quiet-boundary orchestration race.

1. **`transport.isAttached()`** — `inner != null`, the question the callers meant
   to ask. `getKind()` keeps its meaning; nothing else moved.
2. **`deviceIsAttached()` in `index.js`**, one definition for all four call
   sites, with a `getKind()`-based fallback for injected test transports.
3. **`pull()` merges the collection instead of replacing it.** 图鉴 / 捕捉 / box
   are monotone, and the machine *without* the device cannot catch anything, so
   the union is **exact rather than a heuristic** — that is the whole argument
   for doing it automatically. Level/exp/bond still come wholesale from whoever
   held the device. Returns `keptLocal`, and the log says how many entries it
   kept.
4. **`push()` refuses when the remote holds 图鉴/捕捉 this machine lacks** —
   `push-would-lose`, with an `--allow-loss` escape hatch for the one legitimate
   case (a removal you made by hand). This is the check the lease was never
   going to be.

Plus: a catch now forces a publish instead of waiting out the five-minute
debounce, detected by watching `capturedCount` across the tick rather than by
tapping the capture path; and `save-sync-cli.mjs status` prints 图鉴/捕捉/box
next to the level, because on 08-03 the two saves shared a level and that line
said nothing else.

> **The gap, stated plainly: nothing tests the orchestration-level property.**
> The new tests cover `isAttached()` on the transport and the guard inside
> `save-sync.js`. What is *not* covered is "a host in mock mode does not
> publish", which is the actual bug — `makeSaveSync` is built from config inside
> `runHost` and there is no seam to inject a fake. Adding one is the honest next
> step for anyone who touches this.

> **The manual-edit wrinkle.** A monotone merge resurrects a species you removed
> from the save by hand if any copy that still has it gets merged in later. The
> 07-31 removal is the precedent. Publish immediately after any manual edit so no
> such copy survives; `--allow-loss` exists for exactly that push.

## ▶ Flash record: 2026-08-03 13:17, work PC

The device was three days behind the tree — still on the image the work PC
flashed 07-31 afternoon, so without the 08-01 panel-lock fix and the capture
music. Flashed from here, every step verified rather than assumed:

| Check | Result |
|---|---|
| `wifi_creds.h` entries | **2** |
| sdkconfig partition table | already `CONFIG_PARTITION_TABLE_CUSTOM=y` — **the sdkconfig hazard is not live on this machine** |
| app size | 0xfbd60 = 1,031,520 B against the 4M `factory`, **75% free** |
| both SSIDs in the built binary | **present**, no placeholder strings |
| write_flash | three regions, all **hash verified** |
| post-flash boot | `rtc: seeded`, `sdcard: mounted`, `offline-bond: restored`, `GOT_IP` |
| host after restart | holds COM7 (opening it from PowerShell is denied), frames flowing |

Rollback image, taken first because this machine did not produce what was
running:

    ~/cpb-fw-backup-2026-08-03/running-image-0x0.bin   (2,097,152 B, write_flash 0x0)
    sha256 6829d2c99449b30b6a4384e10b7fbdac7ab860b521fbe0d2ea252c5c27a442e3

**It is 0x200000, not the 0x110000 the 07-31 note used.** The partition table
changed to a 4M `factory` on 07-31, so 1MB no longer covers the app region and a
dump that size would silently be a partial image. Size the dump to the partition
table in front of you, not to the last note.

### The SSID check is now a script instead of a squint

`grep -c` on `wifi_creds.h` answers "how many networks did I configure", which is
not the question — the 07-27 incident was a *build* that never saw the file.
CMake evaluates the `EXISTS` check at configure time, so it flashes placeholders
and reports success. The check that actually answers it reads the SSIDs out of
`wifi_creds.h` and looks for each one in `build/pokemon_buddy_fw.bin`, printing
**index and verdict only** so neither SSID reaches a terminal or a log:

```powershell
cd host
node scripts/check-flashed-ssids.mjs ..\firmware\main\wifi_creds.h ..\firmware\build\pokemon_buddy_fw.bin
```

It also fails if any `YOUR_*` placeholder is still in the image, and exits
non-zero either way so it can gate a flash. **Run it between `build` and
`write_flash`, every time.**

### Booting the credential list, seen for real

    connect idx=0 scan   -> DISCONNECTED reason=2
    connect idx=1 scan   -> DISCONNECTED reason=201   (NO_AP_FOUND: the home net is not here)
    connect idx=0 scan   -> ASSOCIATED -> GOT_IP 192.168.1.138

12.8s from boot to an IP, most of it the two failed passes. `pinned=0` throughout,
which is correct for a cold boot. Nothing to fix — recorded because "it tried the
other network and failed" is exactly what a *missing* credential also looks like
in the log, and here it is what success looks like.

## ▶ A PWR power-off loses the clock, and that breaks offline 亲密度 on the commute

**Measured 2026-08-03, work PC**, prompted by the owner starting to power the
device down at night rather than leaving it running. Host stopped, device off for
2m11s, then on with nothing listening but a serial reader:

```
13:01:41  (port went away -- device powered down)
13:03:52  (port open -- device is powered)
13:03:53  #CPB 622 rtc: no valid time
13:03:53  #CPB 919 offline-bond: restored day=20668 hours=0x000000
13:03:56  #CPB 4062 GOT_IP 192.168.1.138
```

The clock face read `--:--` (the deliberate no-time-yet placeholder), confirming
it independently of the serial race.

**So the PCF85063's backup rail does not survive PWR-off.** PWR is wired to the
power path, not the MCU, and it cuts the rail the chip sits on. "Backed by the
18650" is true of the *board doc* and was only ever verified across a **reset**.
The claim further down this file that a device keeping its battery keeps real
time is now marked wrong in place.

### Why this costs more than a blank clock

`compute_current_clock()` returns false with no valid time, and
`offline_bond_note_press()` then **drops the press outright** —
`offline-bond: press dropped, no time` — because it refuses to guess an hour. So
from a cold power-on until the first host contact, offline 亲密度 cannot be
recorded at all. That window is exactly the commute, which is the situation the
feature was built for.

The routine that avoids it, with no code change: **power the device on while a
running host can still reach it.** One sync seeds the chip (`rtc_maintain`) and
the clock is then good for the rest of that boot. Powering on after leaving the
house is what loses the morning.

Nothing was changed in response to this. The alternatives all cost something the
owner has to choose between — recording a press with an unknown hour and letting
the host attribute it breaks the "absent, not guessed" rule that the encounter
context and the RTC read both follow, and would risk paying a slot that was not
earned.

### Two things the same run confirmed, previously only argued

- **A cold boot correctly discards the BSSID pin.** `connect idx=0 scan`, not
  `pinned` — the pin and the DHCP lease are RAM-only statics by design and the
  cold path goes back to a full scan. `ASSOCIATED` at 760ms, `GOT_IP` at 4062ms,
  i.e. **~3.3s of DHCP**, matching the 3.1s in `main.cpp`'s own comment. There is
  no stale-lease hazard on this path; the earlier worry was unfounded.
- **NVS survives a real power-off**, not just a reflash: `offline-bond: restored`
  came back with day 20668. (The mask is empty because the day had already rolled
  over and been cleared, which is the designed behaviour, not a loss.)

> **Also worth knowing, and it is a designed limit rather than a bug:** an
> offline KEY press that never meets a host before midnight is worth nothing.
> The firmware drops the mask on day rollover (`main.cpp`, `offline_bond_publish`)
> and the host drops any other day (`pet/bond.js`, `applyOfflineBond`), both
> because `bondSlots` is per-day and resets — there is no honest way to credit
> yesterday without either wiping today or paying a slot twice. This never
> mattered while the home host ran all night. It matters now.

The reader used for this is `host/out/rtc-coldboot-listen.mjs` (untracked, like
the other probes). Unlike `sd-probe-read.mjs` it does not expect esptool to have
just reset the chip: it tolerates the port vanishing and re-opens every 50ms, so
the operator can take their time between the off and the on.

## ▶ What the HOME PC has to do next

The device is at **work** as of 08-03 and the save on the remote is current.

```powershell
cd "$HOME\claude-pokemon-buddy"
git fetch hugh; git log --oneline HEAD..hugh/main; git pull hugh main
cd host
node scripts/save-sync-cli.mjs status    # figures now include 图鉴/捕捉/box
```

Then **restart the host** — the save-sync fixes above are all in the tick path,
and a host left running is precisely what caused the incident. Do **not** pull
the save unless the device actually travelled home.

~~**Still open from 08-01: the device has not been reflashed.**~~ **Done
2026-08-03 13:17 from the work PC** — see the flash record below. The device is
now carrying the panel-lock fix and the capture music.

Two things to check there:

1. **The sdkconfig hazard below is CONSUMED on the home PC and still live on the
   work PC** if that machine ever had a pre-`partitions.csv` sdkconfig. Symptom
   is a build that fails on app size, not anything about partitions.
2. `pollUsage failed: no-token` repeats in the home PC's host stderr every tick.
   Untouched tonight — it predates this session and only costs the usage rows.

> ⚠ **A machine that has not built firmware since `partitions.csv` landed must
> regenerate its sdkconfig.** `sdkconfig.defaults` selects the new table but
> `sdkconfig` is per-machine and gitignored, so the stale one still has the 1MB
> single-app layout and the ~1MB app will not fit. The build fails loudly rather
> than producing something wrong, but the fix is not obvious from the error:
> delete `firmware/sdkconfig` and run `idf.py reconfigure`.
>
> **Done on the home PC 2026-07-31 evening**, and it went exactly as the work PC
> predicted: the old file had `CONFIG_PARTITION_TABLE_SINGLE_APP=y`, the
> regenerated one has `CONFIG_PARTITION_TABLE_CUSTOM=y`, and `Compare-Object`
> reported **six** differing lines — the three partition settings, each as one
> removal and one addition. Nothing else was lost. The old file was kept as
> `firmware/sdkconfig.bak-20260731` (gitignored, home PC only); delete it once
> the next flash is confirmed good. The build then came out at 0xfba20 =
> 1,030,176 bytes, 75% of the 4MB app partition free.

> **2026-08-01 late morning, home PC — the device wedging on the clock face is a
> panel data race, and it needs a flash to be fixed.**
>
> This is the SECOND cause found today, and it is not the pokedex one below. That
> one was real and is fixed; this one was underneath it.
>
> **Two tasks write the physical panel and nothing kept them apart.** `rx_task`
> blits host frames (`handle_frame_payload`) and `local_clock_task` draws the
> standalone clock. The only guard was a `g_mode` check at the top of the clock
> task's loop — check-then-act, with a window as wide as a whole clock redraw
> (ColorClear + time + ganzhi row + a full-panel `RLCD_Display()`). Press BOOT to
> leave power-save inside that window and the mode flips, the host is told to
> repaint, and `rx_task` starts blitting into the driver a half-finished clock
> draw is still using. `RLCD_Display()` then never returns, `rx_task` stops ACKing
> **forever**, and only a power cycle recovers it. The comment at the task
> creation site asserted this was safe; it had been wrong for months.
>
> Fixed with a `panel_mutex` around every panel write, plus two things that are
> easy to leave out and both matter:
> - the clock task **re-reads `g_mode` inside the lock**, or it repaints the clock
>   over the buddy panel the host has just restored and holds it for 2s;
> - `exit_local_clock_mode` takes and releases the lock as a **barrier** before
>   broadcasting RESYNC, so the host's repaint cannot race the tail of an
>   in-flight clock redraw.
>
> The boot splash in `app_main` stays unlocked on purpose — single-threaded, and
> the mutex does not exist yet.
>
> **How it presented, and why it took all morning:** "设备卡在断网显示", with a host
> log that looked perfectly healthy. Buttons still reached the host (they are
> queued from the esp_timer task, untouched by the wedge), so the device looked
> alive. The decisive measurement was `node scripts/probe-downlink.js` with the
> host stopped: `{"ok":false,"stale":true}` — retries exhausted, no ACK. **That
> probe is the tool to reach for first next time**; everything before it was
> inference. The host cannot answer this question on its own because it discards
> `push()` results — `wrote out/frame.png` is printed whether or not the device
> took the frame. That gap is still open and is worth closing.
>
> ⚠ **Not verified on hardware. The fix is firmware and the device has not been
> flashed.** Until it is, the workaround is: press BOOT **once** and stop, and if
> it wedges anyway, unplug and replug.
>
> **A wrong turn to not repeat.** Before finding this, a repaint-on-reconnect was
> added to `host/src/index.js` on the theory that the panel was a tick behind. It
> is not: `transport/index.js`'s `attachInner` already clears `previousBytes` and
> calls `redrawLastFrame()` on reconnect. The duplicate hung the whole
> main-orchestration suite — all 13 tests passing, process never exiting — and was
> reverted. There is a NOTE at the site now. Also: do not round-trip a source file
> through PowerShell `Get-Content`/`Set-Content`; it mangled `index.js`'s Chinese
> comments and had to be restored from a copy.

> **2026-08-01 morning, home PC — the panel dropping to the offline clock face
> was the pokedex, and it was certain to happen, not unlucky.**
>
> Symptom: "设备又卡在断网显示了", with a host log that looked perfectly healthy —
> `wrote out/frame.png` every minute all night, no errors, no mock fallback.
>
> Cause, and all three parts matter:
>
> 1. The pokedex **draws only on input**, and `shouldPush` stops the tick painting
>    over it. An open, untouched screen therefore sends the device **nothing**.
> 2. The firmware auto-enters local-clock mode after `LOCAL_CLOCK_TIMEOUT_US` =
>    **120s**, i.e. two silent ticks (main.cpp, sensor_task).
> 3. The pokedex's own idle-close is `DEX_IDLE_TICKS_BEFORE_CLOSE` = **3 ticks**.
>
> 2 < 3, so the offline clock face was **guaranteed** to appear over the screen the
> owner was looking at, for the ~60s between the two limits. The two timeouts were
> simply never compared against each other. It self-heals when the screen closes
> and the next frame arrives (auto-entered local-clock exits on any T_FRAME) — but
> KEY does nothing in that mode, only BOOT gets you out, so from the front it reads
> as a device that has hung.
>
> Fixed by making the tick **repaint the held screen's own frame** instead of
> skipping the push entirely (`buttonDispatcher.repaintHeldScreen()`), so the link
> is fed for as long as any screen is up. Do not "fix" this instead by shortening
> the idle-close — the capture screen has no time limit at all and would still be
> exposed.
>
> **The log was the reason this stayed invisible.** `wrote out/frame.png` printed
> unconditionally, after the RENDER, with no idea whether `shouldPush` had let it
> reach the device. A whole night of it sat there while the device got nothing. It
> now says `(panel held by pokedex; buddy panel not pushed)` when the push was
> skipped. **Treat any log line that reports one stage as evidence about another as
> a bug** — this is the second time on this project (the other was
> `ESP serial device detected`, 07-31 morning).
>
> Evidence for the diagnosis, since "it entered local-clock" has two causes: the
> log's full button history was `KEY double`, `KEY short`, `BOOT short` and
> **no `BOOT double` anywhere**, so it was the auto path, not the owner putting it
> into manual power-save.
>
> **Unrelated, found while verifying: two tests in `host/test/integration.test.js`
> are time-of-day dependent** and were pushed that way. "offline days ... (H1)" and
> "genuine inactive day ..." pin `today` but inject no `now`, so they fall through
> to the wall clock, which `bond.js`'s `bondSlotAt` reads. They passed at 20:00 on
> 07-31 and fail at 09:00 on 08-01 **on the same commit** — bond 104.4 vs 104. This
> came in with the work PC's 亲密度结算制 rewrite (`1c85208`, `0a147d3`). Not fixed
> here. Until it is, **the Windows baseline below is two higher in the morning than
> in the evening**, which is a great way to lose an hour. Full run after this
> session's fix: **659 pass / 10 fail of 669** — the 8 environment failures, plus
> these two. (The flaky quiet-boundary race passed this time; it is the 9th.)

> **2026-07-31 evening, home PC — the home checklist above is consumed, and the
> capture screen has music.** In order: pulled the 16 commits (`d3855b5` →
> `97d3595`), stopped the host **before** pulling the save (Lv.5 凯西, exp 0 →
> 0.07), restarted it at 20:19. The device is on **COM3 on this machine, not
> COM7** — that number is per-machine and the handoff had it wrong for home.
>
> Then the feature: **the capture screen now loops a BGM, a catch has its own
> jingle** instead of borrowing the evolution fanfare, **and evolution finally has
> a dedicated track** rather than the four notes it shared with hatching.
>
> **These are original chiptune, not the Ruby tracks the owner asked for, and he
> asked twice.** The ask was 红宝石's music specifically. Transcribing a Game Freak
> composition into the firmware is copying a copyrighted work — and this fork is
> public — so it was declined both times and what shipped is written for this
> project in the same idiom. Say so plainly if it comes up again; do not quietly
> ship a transcription. What the second round DID change is the writing: the first
> pass was scalar and forgettable, and the owner said so. The rewrite has an actual
> motif (one syncopated rhythm restated over three chord sets), a low B-section in
> sixteenths instead of a third melodic phrase, and a C#5 leading tone in the last
> bar so the seam back to bar 1 lands. Those two notes — **repeat a rhythm rather
> than run a scale, and put a leading tone in the turnaround** — are written into
> the seed's header comment, because they are what made the difference.
>
> Retuning by ear is cheap and is meant to be: the score is note names
> (`"D5/8"`, `"F6:700"`) in `host/seed/music.json`, not Hz.
>
> How it is put together, because none of it is where you would guess:
>
> - **`host/seed/music.json` is the single source.** `node scripts/gen-music.mjs`
>   regenerates `firmware/main/music.inc`; a test fails if the committed `.inc`
>   has drifted from the seed, and another fails if any bar of the loop is not
>   1600ms.
> - **The new ids sit ABOVE the 156 species cries** (`SND_EXTRA_BASE` =
>   `SND_SPECIES_BASE + SND_SPECIES_COUNT` = 159), not next to BUI/EVOLVE/HOUR.
>   Inserting them at the bottom would renumber every cry at once, because a cry
>   id is `soundBase + index` — every pokemon would announce itself as the wrong
>   one until both sides were reflashed in lockstep. For the same reason **new
>   tracks go on the END of the seed's `extra` list**: reordering it repoints
>   every id against an already-flashed image.
> - **`SND_EVOLVE` (id 1) is now honestly just the hatching sound.** Evolution
>   moved to its own id; `onboarding.js` is the only caller left. The old shared
>   fanfare was a consequence of the firmware having exactly one, not a decision.
> - **The BGM is a phrase list, not one sound.** `audio_task` renders and plays it
>   one BAR at a time and gives up the speaker the moment anything else is queued,
>   so the catch jingle cuts in within ~100ms instead of after up to a bar and a
>   half. That is also why the scratch buffer stayed small — one bar, not the
>   whole 12.8s loop, which would have been ~400KB of PSRAM held forever.
> - **The host stops the loop in a `finally`.** The device cannot tell that the
>   screen closed; a missed stop is battle music playing over the clock face. A
>   test drives a renderer that throws mid-encounter to hold that line.
> - There is a 10-minute runaway guard in the firmware for the case where the
>   host dies mid-capture. The capture screen has no time limit of its own
>   (owner's call, 07-30), so nothing else would ever bound it.
>
> Verified: `npm test` **658 pass / 9 fail of 667** — the same 9 Windows-environment
> failures documented below, none of them audio. `idf.py build` clean, 0xfbc10 =
> 1,031,184 bytes.
> **Not verified: anything on the actual speaker.** The WAVs were auditioned on the
> PC; the device was **not reflashed this session**, so it is still playing the
> old shared fanfare on a catch and on an evolution, and nothing on the capture
> screen. Reflashing is the whole remaining step.

> **2026-07-31 morning, work PC — the work checklist below is consumed.** In
> order: pulled the 14 commits from the fork (`7edcac1` → `d3855b5`), stopped the
> host, `save-sync pull` (Lv.18 exp=21.07 → exp=21.30, the home PC's evening
> turn), restarted the host at 09:10:26. The first tick settled the day —
> **Lv.23, streak 6** — and published, so both saves match again.
>
> **The host had been running since 07-30 18:34**, i.e. on code older than
> everything the home PC pushed that evening, and it had the device attached and
> was ticking. Same failure as 07-30: the process, not the repo, is what runs. The
> stop-pull-restart order matters — pulling the save under a live host lets the
> next tick write the in-memory copy back over it.
>
> **The remote names on this machine are NOT what `CLAUDE.md` describes.** Here
> `origin` is the *fork* (`Hugh1ezy`) and `upstream` is aquamarinz — exactly the
> opposite of the home PC, where `origin` is aquamarinz. So `main` tracking
> `origin/main` is **correct here** and must not be "fixed"; the 07-30 instruction
> to retarget it applies to the home PC only. A `hugh` remote was added here as an
> alias for the fork so `CLAUDE.md`'s checklist runs verbatim on both machines.
> The live hazard is the other direction: `git push origin main` is safe from this
> machine and pushes to **aquamarinz** from home.
>
> **A restart log looks alarming and is not.** `ESP serial device detected;
> upgrading mock transport to serial` is printed **only** by `runProbe`, i.e. only
> when a host that already fell back to mock later finds the device. A clean start
> that finds it in `createTransport`'s initial `connectAny()` attaches silently and
> logs nothing at all, so its absence after a restart reads exactly like "the
> device never came back". The line that would actually mean mock is `ESP serial
> port not found; using mock transport`; check for **that**, or check who holds
> COM7 (opening it from PowerShell fails while the host has it). Half of this
> morning went into re-deriving that.
>
> **Still not done: nothing has been heard.** The speaker check below is
> untouched — it needs the owner and the hardware.

> **The home checklist is consumed and the evening went well past it.** Done in
> order: pulled to `7edcac1`, confirmed the save matched, re-baked all 156 sprites,
> added the home SSID to `config.json`'s `places`, restarted the host. The pokedex,
> both left-panel rows and the capture screen are live and were seen working, and
> the owner caught their first wild pokemon.
>
> Then, the same evening: encounter weights rebuilt from canonical Gen-1 data,
> cries extended from 18 species to 156, six sound triggers wired, audio renamed to
> pinyin, cries moved to on-demand synthesis, and **the firmware rebuilt and flashed
> from home** with both wifi networks in it. Everything is pushed; the tree and the
> save were both in sync at handoff.
>
> **Nothing audible has ever been verified** — the speaker module is at work. That
> is the first thing to do there. See the checklist below.
>
> **Read `CLAUDE.md` (new, repo root) before doing any of this again.** It holds
> the sync routine as a single checklist, because the reason a whole work day
> looked missing tonight was procedural, not technical — see the remotes note
> below.

**What 07-30 actually did on the work PC: restarted the host.** It had been up
since 07-28 17:51, which is *older than the encounter wiring the home PC pushed
that evening*, so `applyEncounterTick()` had never once run on this machine —
the engine was in the repo and not in the process. The first line of the new
log confirms it fired: `pokedex: 妙蛙种子 recorded (owned, not caught)`. If a
feature looks dead here, check the host's start time before you check the code.

The session before it, 07-29 on the work PC, did nothing but sprite artwork:
eight review rounds with the owner over the 151 dex images, plus twenty species
renamed to their pre-unification Chinese names. **That work is finished and
signed off** — read the 07-29 section before touching `bake-assets.mjs`, because
several of its knobs exist to record a decision that was already made and
reversed once.

The session before it, on the **home PC** the evening of 07-28, took the save
handoff live on that machine and wired the encounter engine into the tick; its
record is kept below in full. Earlier on 07-28, on the work PC: the first three
phases of the 151-species pokedex work. Before that: the wake latency, the
weekday 亲密度 payout, the half-heart rendering, and save syncing itself.

**Next up: the visible half of P4 — the row 3 notification and the capture
screen.** Nothing in the sprite work blocks it.

> Note for whoever reads this next: the work PC spent 07-29 on `7d2b799` and
> only discovered the home PC's two commits when it went to push. Nothing was
> lost — the conflict was in this file alone and both sides are merged here —
> but `git pull` before starting, not before pushing.

Three remotes now:

| Remote | What |
|---|---|
| `hugh` | `Hugh1ezy/claude-pokemon-buddy` — the fork, **public**, code lives here. Push here |
| `origin` | `aquamarinz/claude-pokemon-buddy` — original, read-only. Never push |
| `save` | `Hugh1ezy/cpb-save` — **private**, holds only `state.json` (`docs/save-sync.md`) |

⚠ **Corrected 2026-07-30 (home PC).** This table named the fork `origin` and the
original `upstream` for as long as it has existed, and both are wrong on both
machines: there is no `upstream` remote at all, and `origin` is the aquamarinz
original. Two consequences, both of which bit today:

- A bare `git pull` (as the checklist below said for months) pulls from
  **aquamarinz** and can never bring over the other machine's work. `main` also
  shipped *tracking* `origin/main`. Fixed on the home PC 07-30 with
  `git branch --set-upstream-to=hugh/main main` — **git does not carry this, so
  check it on the work PC too**: `git rev-parse --abbrev-ref HEAD@{upstream}`
  should print `hugh/main`.
- `git fetch origin` silently leaves `hugh/main` stale. On the evening of 07-30
  that made this day's 23 commits invisible from home and produced a confident
  report that the work PC had done nothing. Fetch `hugh` **by name**.

Buddy as of this note: **妙蛙草 (ivysaur) 慢性子** — it evolved from 妙蛙种子 on
07-30 — published to `save` from the **work PC** at the end of 07-30. Same
lineage throughout; the nature has matched at every check, so the two-buddy trap
below has not recurred. The home PC's setup is complete and its host is running,
but **it has not held the device since 07-28** and has not run the checklist
below even once.

**图鉴 2/151 · 捕捉 0** is the true state. Both entries came from `recordSeen`
(the starter line), not from catches — every catch so far was a fixture, and
they have been stripped twice. See the fixture note under the capture section.

---

## ▶ What the WORK PC has to do, in order — ✅ done 2026-07-31 09:10

Steps 1-6 below all ran or were checked this morning; step 1 turned out to be
wrong for this machine (see the remote-names note at the top). Kept as written
because it is also the arrival routine for the next trip.



```powershell
cd "$HOME\claude-pokemon-buddy"
git rev-parse --abbrev-ref HEAD@{upstream}          # want hugh/main, see the remotes note
git fetch hugh; git log --oneline HEAD..hugh/main; git pull hugh main
grep -cE '^\s*\{\s*".*",\s*".*"\s*\}' firmware/main/wifi_creds.h   # want 2
cd host
node scripts/save-sync-cli.mjs status               # both saves, no writes
node scripts/save-sync-cli.mjs pull                 # once the device is at work
```

Then restart the host. In detail:

1. **Check the branch tracking first.** `main` shipped tracking `origin/main`
   (aquamarinz), which is why a bare `git pull` never brought the other machine's
   work over. Fixed on the home PC 07-30; **git does not carry it**, so this
   machine is probably still wrong. `git branch --set-upstream-to=hugh/main main`.
2. **Check `wifi_creds.h` has 2 entries** before ever flashing from here. The home
   copy had only one on 07-30 and now has both. This file is per-machine.
3. **Take the save once the device is actually at work.** It spent the night at
   home with the host attached, so home is the owner and `pull` is the direction.
   The replaced file lands at `state.json.presync` as a one-step undo.
4. **Restart the host.** A lot of 07-30-evening work changes the tick.
5. **No re-bake.** Nothing since 07-29 touched the artwork.
6. **No reflash needed** — the device is already running the 07-30 evening image,
   flashed from home, and it carries **both** networks, so it will join the work
   wifi on its own. If it does not, that is news; probe TCP 7311 before assuming.

### The device already has tonight's firmware

Flashed from the home PC over COM3 on the evening of 07-30 and verified: hashes
checked, device rejoined the home network, panel drawing normally. The sound table
is 159 entries and cries are synthesized on demand, so the PSRAM warning that used
to live here is gone — the board has **8MB** (esptool prints it on every connect)
and the buffer is now one ~37KB scratch instead of 2.36MB of pre-rendered audio.

### ▶ The first thing worth doing at work: actually listen

**Nothing had ever been heard until 2026-07-31 evening**, when the owner put
external speakers on at home. Every sound change before that was verified by
rendering WAVs and by reading the code. Eight places should now make noise:

| when | what plays |
|---|---|
| KEY short press | the buddy's own cry (played by the firmware, not the host) |
| a wild pokemon appears | that species' cry |
| **the capture screen opens** | **the capture BGM, looping until the screen closes** |
| **a capture succeeds** | **the capture jingle** (was the evolution fanfare until 07-31) |
| the pokedex cursor lands on a species you own | that species' cry |
| **an evolution animation** | **the evolution track** (its own since 07-31, ~2.5s) |
| hatching, during onboarding | `SND_EVOLVE` — the old four-note fanfare, now only this |
| top of the hour | the chime |
| KEY short press **while the capture screen is up** | *nothing* — see below |

That last row is deliberate. While the BGM holds the speaker the firmware
suppresses the KEY cry (`g_bgm_active`), because on the capture screen KEY is the
throw button: firing the buddy's cry on every throw would both talk over the music
and kill it, since any queued sound ends the loop by design.

`node scripts/play-test.js` auditions the three system sounds over serial without
waiting for an event. `node scripts/cries-to-wav.mjs <pinyin>` renders any cry to a
WAV on the PC for comparison — the synthesis there is a sample-for-sample port of
`synth_tone`, so the two should sound identical. If they do not, that mismatch is
the finding. `node scripts/cries-to-wav.mjs capture` renders the two music tracks;
the BGM is written out as two passes of the loop so the seam back to bar 1 can be
judged.

Audio names are pinyin now (`node scripts/species-pinyin.mjs` prints the list).

### Still open, in rough priority order

1. ~~**The 138 generated cries have never been heard.**~~ **Owner's verdict
   2026-08-03, on the image flashed that afternoon: the sounds are fine and he
   does not want anything changed.** So the "expect some to be wrong and plan to
   fix them by ear" worry is answered for now, and the reworked capture BGM,
   capture jingle and evolution track are all accepted on hardware.

   What that does **not** mean: he has not auditioned 138 species one at a time,
   because most of them have not been encountered yet. A cry that turns out wrong
   will surface the first time its species appears, not before. Treat this as
   "nothing has sounded wrong so far", not as sign-off on every entry — and do
   not go tuning cries nobody has complained about (07-29's sprite lesson: a fix
   widened past the report is how a fix becomes a regression).
2. **`bubble` text for the 138 generated species is placeholder** — the last two
   characters of the Chinese name. It is the only non-derived thing in
   `seed/species-cries.json` and wants replacing with real onomatopoeia over time.
3. ~~**Evolution plays the generic fanfare, not the new form's own cry.**~~
   **Half-resolved 07-31**: evolution has its own ~2.5s track now, and the catch
   no longer borrows anything. Still open is the smaller wish underneath it —
   playing the *new form's cry* at the reveal frame, on top of the track.
4. ~~**SD card cannot be used yet.**~~ **Resolved 2026-07-31 — the card works.**
   The owner produced the board's pinout sheet; `sdcard: {clk: 38, cmd: 21, d0: 39}`
   went into `board_cfg.txt` and was verified on hardware. See the 07-31 section.
5. ~~**The app partition is 98% full**~~ **Resolved — `partitions.csv` gives
   `factory` 4M, and the 2026-08-03 build measured 0xfbd60 = 1,031,520 bytes,
   i.e. 75% of the partition free.** The diagnosis in the old note was right:
   the ceiling was IDF's `singleapp` default, not the hardware. The flash is
   16MB and ~12MB after `factory` is still unallocated, so there is room to do
   this again if a firmware feature ever needs it.
6. **`pollUsage failed: no-token`** on the home PC every tick — no usage token
   configured there, so the WEEK bar and the 5h/wk figures stay blank at home.

If `status` shows the remote *behind* what is on this machine, stop and read "the
two-buddy trap" below before running anything.

## Session record: 2026-07-31 afternoon, work PC

### 亲密度 is settled now, not paid as it is earned

The owner reworked the rule twice in one afternoon and the end state is:

- **Nothing is granted as a half heart is credited.** `applyBondTick` records
  what is owed in `bondUnpaid` and grants no exp.
- **Settlement happens when the day's window shuts** — 19:00 ordinarily, 21:00
  on a Thursday, via `bondWindowClosed` rather than a hardcoded hour — **or when
  the pokemon leaves the panel**, whichever comes first. `settleBondExp` pays
  once and zeroes what it owed.
- **Settling empties the hearts on the panel too.** They are a running total of
  what has not been paid, not a record of the day.
- A day that rolled over without ever reaching its own 19:00 (device off, host
  off) is settled before the reset, or those halves would simply evaporate.

`bondSlots` is untouched by any of this and it is what keeps the day honest: it
still records which HOURS have been collected, so emptying the hearts cannot buy
a second helping. There is a test pinning exactly that.

**A short-lived "cash in on swap" step existed for about an hour and is gone.**
It paid on top of the exp `applyBondTick` had already granted — a genuine second
payment. It was implemented as asked, flagged as a second payment, and the owner
removed it once the mechanics were clear. If a future note describes hearts as
"unspent", it is describing the version that no longer exists.

**`bondUnpaid` is registered in all three of `state.js`'s whitelists.** That file
rebuilds the save from named fields; a field merely carried on the object is
dropped between one save and the next load, which is how the capture fixture's
`test` flag once vanished for five real catches.

### Two bugs with one cause: the tick is 60 seconds wide

Both were reported by the owner within an hour of each other, and both come from
queueing work to a tick that may not run for a minute.

- **Confirming a swap dropped him back on the panel still showing the old
  buddy.** It looked like nothing had happened.
- **A caught pokemon could be caught again.** The notice stayed up because the
  save still held the offer, so the capture screen reopened on the same
  encounter. It went into the collection twice, and `capturedCount` was
  corrected by hand from 4 to 3.

`wakeTick()` cuts the loop's sleep short when a swap or a capture result is
queued. The tick is still the only thing that writes the pet — only *when* it
next runs changed. For the capture there is a second, independent guard: the
dispatcher remembers the `offeredAt` it has already played and refuses to
reopen that encounter, so the fix does not depend on timing at all. Keyed on
`offeredAt`, so the next offer of the same species plays normally. Backing out
(`aborted`) deliberately does not close the offer.

> **`wakeTick` killed the host on its first outing**, and the failure is worth
> knowing: it was declared with `const` next to `stop()`, i.e. *after* the
> dispatcher that takes it, so the temporal dead zone threw a ReferenceError the
> moment `main()` ran. The device sat on its local clock face and the only
> evidence was one line in `out/host-autostart.log`. It is now declared beside
> `timer`/`resolveLoopSleep`, above every use.

## Wild availability: half-fixed, and blocked on the evolution table

The owner caught a species that **cannot be obtained in the wild in Gen 1** —
verified against Serebii, trade-evolution only. He spotted it himself.

The owner caught a species that **cannot be obtained in the wild in Gen 1** —
verified against Serebii, it is a trade-evolution only. He spotted it himself.

The interesting part: **`seed/wild-rarity.json` is already correct.** That entry
carries `areas: 0, methods: []`, i.e. the canonical data says exactly what it
should. So the defect is in the step that turns that data into encounter
weights, not in the data. Anything with `areas: 0` (equivalently, an empty
`methods`) must not be offerable at all.

**The rule is in as of 2026-07-31 and it took three attempts, each one corrected
by the data rather than by reasoning:**

1. `evolvesFrom != null` — wrong. Five Gen-1 species list a **Gen-2 baby form**
   as their pre-evolution, so the chain leaves these 151 and nothing in the game
   could ever evolve into them.
2. "has an ancestor catchable on foot" — wrong, and it costs the three starter
   lines: the starters are gifts with no walking encounter, so their evolutions
   would have stayed in the wild pool.
3. **In: a chain that stays entirely inside the 151, AND a branch in
   `seed/evolution/*.json` that actually reaches the species.**

The third clause is not tidiness. Without it the rule **stranded 27 of 36
species permanently** — measured, not feared. `seed/evolution/` is the *playable*
table (triggers, not the canonical graph) and today it covers a fraction of the
Gen-1 lines. Gating on it also makes the rule self-maintaining: every line added
to the evolution table takes its forms out of the wild pool on the next
regenerate, with no edit to the generator.

Net today: **9 excluded, 0 stranded**. A weight of 0 needs no engine change —
`candidates()` already drops anything not greater than zero — and
`test/encounter.test.js` now asserts that every zero-weight species is an
evolution target, by counts only, so that file stays safe to read.

**Still open, and it is the blocker for everything else here: the evolution
table covers 14 targets out of 151.** Until the Gen-1 lines are filled in, most
wild-unobtainable species stay in the wild pool, including the one the owner
actually reported. The owner has since specified how he wants difficulty
mirrored from the games and asked that none of it be discussed with him again —
so the design lives in the spoiler files and the next session should read
`gen-encounters.mjs` and get on with it. Report progress as counts and summary
figures only.

**One real cost, recorded so nobody rediscovers it as a mystery:**
`sim-encounters.mjs` does not model evolution, so it can no longer answer "is
the dex completable" — it now reports 0/40 with the encounter path topping out
short of 151. That guard needs evolution modelling before it is meaningful
again. Do not read its silence as a regression in the weights.

The wrongly-caught pokemon was removed from the save by hand at the owner's
request (undo copy at `out/state.json.prealakazam`): dropped from `dexCaught`
and the box, and `capturedCount` decremented by exactly one. Note for whoever
looks: `capturedCount` was 3 against 2 box entries before that edit, i.e. it was
already one ahead of the box, and **that discrepancy was left alone** rather
than tidied, because it was not what was reported.

## Today's hearts no longer travel with a swapped pokemon (owner, 2026-07-31)

> Superseded in part the same afternoon — the settlement section above is
> current. What survives from this note: `bondHalves` resets on a swap, and
> `bondSlots` does not.

He swapped to a pokemon caught minutes earlier and it arrived showing a heart
and a half. Those halves were the **day's**, earned by the buddy that just left:
`swapActiveBuddy` deliberately left `bondHalves` alone as "the trainer's day
bookkeeping". Correct reasoning, wrong result — read off the panel it says "this
one already likes you".

`bondHalves` now resets to 0 on a swap. Two things did **not** change, and both
matter:

- **`bondSlots` still does not reset.** It is the mask of which HOURS have paid
  out today. Resetting it with the halves would let a swap re-collect hours
  already earned, so swapping back and forth would pay the day twice. Keeping it
  means the incoming pokemon earns from whatever is left of the day.
- **Nothing is "converted to exp" on the swap**, despite that being how the
  owner described it, because there is nothing pending: `applyBondTick` grants
  the exp for a half heart at the moment it credits it. The outgoing pokemon
  already holds every point those hearts were worth.

`test/roster.test.js` had a test asserting the old behaviour (`bondHalves` 4
after a round trip). Its expectation was changed to 0 with a note, rather than
the test being deleted — the round-trip property it was really guarding, that
level/exp/bond/nature come back intact, is unchanged and still asserted.

## Two hardware numbers, measured 2026-07-31 (probes since removed)

Both were guesses that decisions were resting on. The probe code lived in
`app_main` for one flash and was deleted again — the numbers are the artefact.

### The panel is fast: a full flush is ~11.75 ms

    panel: RLCD_Display avg=11753us min=817us max=12360us n=20

A whole 400x300 flush in **11.75 ms**, i.e. ~85 fps of headroom. The worry that
a reflective LCD would turn out to be tens of milliseconds a frame was simply
wrong, and it had been quietly bounding what the device could ever render on its
own. Two consequences:

- the offline capture minigame's 50 ms frame is trivially affordable — the flush
  is under a quarter of it;
- a Game Boy core at 30 fps (33 ms) has ~21 ms per frame left for emulation,
  which is comfortable. 60 fps leaves ~5 ms, which is not.

(`min=817us` is the first call in the loop, before there was anything to push;
the honest figure is the average.)

### PWR is not visible to software at all

Ten unclaimed pins (1, 2, 3, 4, 7, 15, 17, 42, 47, 48) were pulled up and
watched for 25 s while the owner pressed PWR repeatedly:

    pwr-scan: watching 10 pins for 25s
    pwr-scan: done, 0 pin(s) changed

All ten sat high at rest and none moved. Together with the board's pinout sheet
— which assigns a GPIO to everything else, down to `SD_CD_PIN GPIO 17(NC)`, and
gives PWR none — **PWR is a hardware power-control button wired to the power
path, not to the MCU.** So it cannot be read, cannot be given a function, and
its long-press-to-shutdown cannot be remapped in firmware. It is not a spare
third button; the device has exactly two.

GPIO 6 was deliberately left out of the scan: the sheet calls it RLCD_TE, the
panel's tearing-effect output, which toggles on its own and would have read as a
press. The result is only as good as the assumption that the press happened
inside the window.

## Session record: 2026-07-31 morning, work PC — the RTC now works

`components/port_bsp/pcf85063.{h,cpp}`, on the same I2C bus as the SHTC3 and the
ES8311 (SDA 13 / SCL 14, address 0x51), backed by the 18650. The chip has been
on the board the whole time; only the driver was missing, and `main.cpp:1155`'s
"No RTC chip driver exists in this codebase" was read once as "the board has no
RTC", which it never said.

`rtc_seed_clock()` seeds the RAM clock from the chip at boot; `rtc_maintain()`
on the 30s sensor cadence keeps the chip agreeing with whatever the host last
sent. Three decisions worth not undoing:

- **The oscillator-stop flag (seconds bit 7) makes `read()` fail.** That flag
  means the backup rail dropped: the registers still hold digits, and they are
  not a time. Absent beats plausible-but-wrong, which is the same rule the
  encounter context follows.
- **Control_1 is read-modify-written**, clearing only 12/24 and STOP. Bit 0
  selects the crystal's load capacitance (7pF vs 12.5pF) and is a property of
  this board that is not visible from software — writing a flat `0x00` would
  quietly pick one and pay for it in accuracy.
- **The one-minute deadband in `rtc_maintain` is load-bearing.** Writing on
  every disagreement rewrites the chip constantly, and every write zeroes the
  seconds register, so a device with a host attached would be dragged
  permanently tens of seconds late — which is exactly the reading offline
  亲密度 depends on.

Dates use Hinnant's civil-calendar algorithms and touch no libc time zone:
`epoch_day` is a **local** calendar day count, so a timezone conversion here
would be the bug, not the fix.

Measured on hardware:

    (first boot after flashing)  #CPB 642 rtc: no valid time
    (host up 45s, then reset with no host)
                                 #CPB 622 rtc: seeded 10:46 epoch_day=20665
                                 offline-bond: restored day=20665 hours=0x000400

PC clock at that moment was 10:47:10, epochDay 20665 — hour and date both
agree. The second line also proves the offline mask survives a **reflash** and a
reboot, since `0x400` is the hour-10 press made before the firmware was rebuilt.

## Session record: 2026-07-31 morning, work PC — offline 亲密度

Presses made away from a PC used to be worth nothing: the hourly slot is
credited by the host, and a press that reaches no host never happened. The
device now records the HOURS it was pressed in and the host credits them on
reconnect. `T_OFFLINE 0x88 = [epoch_day u16][hours u24]`.

**It is a bitmask of hours, not an event log, and that shape is the design.**
Three properties fall out of it, and they answer the questions the owner
actually asked ("won't it stack?", "what if the upload fails?"):

- replaying it credits nothing, because the host already dedupes slots through
  `bondSlots` — so there is no ack, no sequence number, and no delete-after-
  upload step, which is the step that loses data when the upload fails;
- it cannot grow: ten presses in an hour are one bit, a whole day is five bytes;
- publishing needs no link-state machine. It rides the 30s sensor cadence
  unconditionally; if nobody is listening the write just fails.

The HOUR travels, not the slot index — hour→slot depends on the day's window
(Thursday opens at 11) and that table is the host's policy. Storage is **NVS,
not the SD card**: a handful of bytes that must survive a brownout is what NVS
is for, and a FAT volume on a card that can be physically removed is the
opposite. The card is for read-mostly bulk (sprites, glyph atlases) later.

### The delivery check was wrong, and hardware said so immediately

The first version recorded a press when the BUTTON broadcast "reached no link".
**Both links lie about that.** `usb_serial_jtag_write_bytes` returns success as
soon as the bytes fit the driver's 1KB TX ring buffer, whether or not anything
is draining it — an 11-byte BUTTON frame always fits. And `wifi_write_raw`
deliberately reports "no client connected" as success. The first on-hardware
press recorded nothing, with no diagnostic, and looked exactly like a dead
feature.

Ask it in the direction that can be answered: **inbound**. A live host pushes a
frame ~3x a second, so `HOST_SILENT_US` = 30s of silence on `g_last_frame_us` is
unambiguous. Deliberately not `LOCAL_CLOCK_TIMEOUT_US` (120s) — that answers
"has it been gone long enough to put the clock face up" and can afford to be
slow; this one bounds how much of a commute's start is missed.

False positives are harmless by construction: the pokedex and capture screens
suppress pushes, so a press then looks absent — but those screens only exist
because a host is drawing them, so the press is credited live and the recorded
hour replays as a no-op.

### What is verified and what is not

Measured on hardware, host stopped, COM7:

    OFFLINE-BOND frame: epochDay=20665 hours=[10]       (republished every 30s)
    onOfflineBond #1: {"epochDay":20665,"hours":[10]}   (through the real transport)

So: detection, recording, NVS persistence, publication, republication, framing
and the host's parse/event path are all confirmed on the real device.

**The credit itself was NOT demonstrated live**, and the reason is worth
knowing: the hour that got pressed had already been credited that day, so the
replay correctly did nothing and printed nothing. That IS the idempotency
property, just invisible. It has unit tests (`test/offline-bond.test.js`, 13 of
them). To see it for real, press KEY with no host during an hour whose slot is
still unpaid and watch for `bond: credited N offline half-heart(s)`.

~~**Known gap: a press after a reboot with no host since is dropped**~~ —
**closed the same morning, see the PCF85063 section below.**

Two testing traps, both of which cost a round here: the `diag()` line at press
time is lost unless a reader is already attached (see the USB-JTAG note in the
07-31 TF-card section), and backgrounding the reader with a shell `&` inside an
already-backgrounded task kills it as soon as the parent exits. `out/offline-bond-listen.mjs`
(untracked) avoids all of it by watching for the republished frame instead of
the press moment.

## Session record: 2026-07-31 morning, work PC — the TF card works

### The pins, and that they are now measured rather than claimed

The owner has the board's own pinout sheet. TF slot: **CMD 21, CLK 38, DATA 39**,
CD on GPIO 17 but marked NC. One data line, so **1-bit SDMMC** — and that falls
out on its own, because `codec_init.c` derives the width as `cfg.d3 ? 4 : 1` and
leaving `d1`/`d2`/`d3` out of the config selects 1-bit. None of 21/38/39 collides
with anything in use (LCD 5/6/11/12/40/41, I2C 13/14/15, I2S 8/9/10/16/45/46,
buttons 0/18, PSRAM 26/30).

`sdcard_probe()` in `main.cpp` mounts the card at boot and round-trips a file
through it, reporting on the `diag()` channel. Measured on hardware:

    #CPB 864 sdcard: mounted 30474MB name=USD
    #CPB 878 sdcard: readback ok

A 32GB card, mounted, written, read back and the file removed, in 14ms. The probe
is non-fatal in every branch and nothing in the product uses the card yet — it
exists so the pin numbers are a measurement and not a diagram.

### Filenames on this card are 8.3, and nothing tells you

The first probe printed `sdcard: write open failed errno=22` and read exactly
like a broken card or a wrong pin. It was neither: this build has
**`CONFIG_FATFS_LFN_NONE`**, so a stem longer than 8 characters fails `fopen`
with `EINVAL` and no other diagnostic. `cpb-probe.txt` is a 9-character stem.
Renamed to `cpbprobe.txt` and it worked on the next flash. **Anything written to
this card later — the offline event log especially — is under the same rule**
until somebody deliberately enables LFN.

### Capturing `diag()` output has two traps, and both cost a round

- **`usb_serial_jtag_write_bytes` drops its output when nobody is reading.** The
  probe runs in `app_main`, so the boot right after `idf.py flash` emits it into
  a FIFO with no reader attached, the 100ms timeout expires, and the line is
  gone. The reader has to be attached *before* the boot you want to see.
- **Do not drive DTR/RTS from node to force that boot.** Doing so put the chip
  into the ROM loader instead of the app — `rst:0x15 (USB_UART_CHIP_RESET),
  boot:0x23 (DOWNLOAD)`, visible only because the reader dumped raw bytes. What
  works: run `esptool --after hard_reset chip_id` and start the reader
  immediately after it exits, letting the reader retry the open while the USB
  device re-enumerates. `out/sd-probe-read.mjs` (untracked) does exactly that.

### There was no rollback image on this machine, and now there is

`cpb-firmware-merged.bin` in the repo root is from **07-27** (424KB) and
`build/pokemon_buddy_fw.bin` was from **07-28** — but the device had been flashed
**from home on 07-30**. So nothing on this machine matched what was running, and
a bad build would have had nothing to go back to.

Read off the device before flashing anything:

    ~/cpb-fw-backup-2026-07-31/running-image-0x0.bin   (1,114,112 B, bootloader
    + partition table + nvs + phy + app; reflash with write_flash 0x0)
    sha256 c735fd019cbc79e7c80ea1cdf37defa7286da10bc93153fff12b82b9eae48086

**Take this dump before every flash from a machine that did not produce the
running image.** It costs 98 seconds and is the only exact copy.

### Flashing does not touch the save, and that was verified rather than assumed

The owner asked whether flashing risks the buddy's data. It does not: the save
lives in `host/out/state.json` on the PC, and the firmware writes **nothing**
persistent — `nvs_flash_init()` at `main.cpp:1059` is there because the wifi
stack requires it, and no game state goes near it. Checked across the whole
session: Lv.23 exp=1.4249… bond=29.199… before the first flash and identical
after the second.

### The board has a real RTC, and the codebase's comment was misread once

`main.cpp:1155` says "No RTC chip driver exists in this codebase", which is true
and is about the *driver*. The **board carries a PCF85063** on the same I2C bus
(SDA 13 / SCL 14, INT on GPIO 15), backed by the 18650. So a device that keeps
its battery keeps real time with no host and no network — which removes the
reason to reach for SNTP in any offline work. Nobody has written the driver yet.

> ⚠ **The second sentence is wrong and was measured wrong on 2026-08-03.** "Backed
> by the 18650" is what the board doc says; it does not survive a **PWR
> power-off**, which cuts the rail the chip sits on. Keeping the battery in the
> device is not the same as keeping the device powered. See the 08-03 section at
> the top — a real 2-minute power-off came back with `rtc: no valid time` and a
> `--:--` clock face. This claim was written from a *reset* surviving and was
> never tested against a power cycle.

## Session record: 2026-07-30 late evening, home PC

### A whole work day was reported as missing, and the cause was the remote names

The owner arrived home, asked why the pokedex would not open, and was told the
machines were already in sync and that the work PC had committed nothing all day.
Both halves of that were wrong. The 23 commits were on the fork, pushed at 18:33,
and the error surfaced only when a push was rejected.

What actually happened: `git fetch origin` was run instead of `git fetch hugh`.
`origin` is the aquamarinz upstream, so the fetch succeeded, reported nothing new,
and left `refs/remotes/hugh/main` sitting at whatever the last session had left
there — two days stale. **A stale tracking ref is indistinguishable from a quiet
remote.** Check the ref's date, not just the diff.

Two fixes landed from this, both above: the corrected remotes table, and
`main`'s upstream retargeted to `hugh/main` on this machine. The work PC still
needs the second one — git does not carry it.

`CLAUDE.md` at the repo root is new and holds the whole sync routine. It is
deliberately **one** checklist reconciling both directions rather than a
departure list and an arrival list: the owner said they will say
「做准备工作」 on *arriving* at work, which is the opposite of what a
"prepare to leave" reading would do, and a routine that depends on the owner
picking the right phrase is a routine that will fail. Pushing inside that routine
is pre-authorised — the owner's words were 「不用问我」 and 「不然很可能就没事做了」.

### The pokedex screen reported the collection as empty

`dexSource` in `index.js` read `runtime.pet` with a `?? {}` fallback, and
`runtime.pet` is unset until the first tick assigns it. Opening the screen in the
seconds after a host start therefore rendered `dexProgress({})` — **0/151 with
all 151 silhouettes black** — while the save on disk held two entries. Seen for
real tonight. `getView` and the tick in the same file already fell back to
`loadState(statePath)`; this call site had been missed. Fixed the same way.

It reports the collection as *empty* rather than as *unknown*, which is the part
that matters: the owner reads it as lost data.

### Sound is wired into the encounter and the capture, without a reflash

The audio stack was already complete and had simply never been connected to the
07-30 screens — `capture-screen.js` and `dex-screen.js` contained no sound calls
at all. Now:

- **A new offer plays the wild species' cry**, from the tick's call site rather
  than from inside `applyEncounterTick`, which stays pure. Keyed on `offeredAt`,
  so a second offer of the same species still cries and a re-render never does.
  Quiet hours are already handled by the gate around the transport, so it must not
  check the clock again.
- **A catch plays the evolution fanfare**, reused the way `onboarding.js` already
  reuses it for hatching. Injected into `runCaptureSession` like every other side
  effect there, and fired *before* the phase, because `play()` loops at 20fps for
  the phase's whole duration and anything inside it retriggers every frame. Pinned
  by a test that asserts exactly one call.

**What is left needs a reflash, and is the real remaining sound work.**
`seed/species-cries.json` covers **18 of 151** species — the three starter lines
and the nine eeveelutions. `cryAudioId` returns null for the other 133, so
tonight's encounter cry is silent for 88% of what the engine can roll. Extending
it means regenerating `species_cries.inc` via `scripts/gen-cries.mjs`, checking
the PSRAM budget for 151 synthesized buffers instead of 21, and flashing. Note
that `committed species_cries.inc matches regenerated output (no drift)` is one of
the nine tests that always fail on Windows for want of python — so on either of
these machines that regeneration cannot be verified by the suite.

Before flashing anything, re-read the `wifi_creds.h` rule below: a build listing
only the network you are standing in is how the work network got dropped on 07-27.

### Encounter rarity now comes from canonical data, and completion got FASTER

The owner noticed a stage-2 pokemon turning up as casually as a stage-1 one and
asked for the games' real numbers rather than anyone's judgement. New:
`scripts/gen-wild-rarity.mjs` → `seed/wild-rarity.json`, pulled from PokeAPI for
Generation 1 and counting **walk encounters only** (rods, surf, gift, trade and
static are recorded but do not count as wild presence). Cached, so re-running is
free. That file holds facts about the real games and is **not** a spoiler — it
says nothing about which species this project surfaces under which conditions.

The generator's weights are now `capture_rate × availability`. Those answer
different questions and both are real: capture_rate is "how hard once found",
availability is "how often found", and using only the former was the gap.

The part worth remembering is the mistake in the middle. Full canonical rarity
first measured 0/40 runs completing, which read as proof that canonical rarity and
a completable pokedex were incompatible. **It was not.** Completion time is
dominated by the tail, and the tail was being starved by encounters spent
re-offering species already collected. Dropping `caughtWeight` from 0.008 to
0.0015 made full canonical affordable *and* faster than the original:

| | complete | median | slowest |
|---|---|---|---|
| before | 40/40 | 331 | 393 |
| now, pure canonical | 40/40 | **316** | **351** |

Raising `perTickChance` (0.0065 → 0.0095) bought only 13 days by comparison —
throughput is not the constraint. The full measurement table is in the generator.

Aggregates only, since the mapping stays secret: second-stage share of the pool
4.1% → 2.0%, the 61 species that never appear on foot 18.4% → 8.7%, base forms
69.2% → 78.6%.

### Sound: five of the six places that should cry now do

Audited on request. Before tonight: KEY press (played by the **firmware** from
`setActiveCry`, which is why `signature-anim.js` deliberately does not also call
playSound), evolution, hatching and the top-of-hour chime. Added: the wild
encounter, the successful capture, and the pokedex cursor. Still bare: evolution
plays the generic fanfare rather than the new form's own cry.

The cry list went 18 → 156 (`scripts/gen-species-cries.mjs`), derived from real
height and weight for pitch, evolution stage for length, and primary type for
contour. **Order is an ABI**: `cryAudioId` is `soundBase + index` and the firmware
table is generated from the same order, so reordering silently remaps every sound.
The first attempt rebuilt the list from the 151-entry pokedex, which dropped the
five non-Gen-1 eeveelutions and shifted everything after them — the cry list is
not the dex. The original 18 are byte-identical at their original indices, so a
device on old firmware still plays ids 3..20 correctly and ignores the rest.

One self-inflicted outage worth recording: entries also need
`bubble{idle,happy,strained}` for the on-screen speech balloon, and the first
generated batch omitted it, so `cries.js` threw at **import** time — one pokemon
without a catchphrase stopped the entire host from starting. `cries.js` now falls
back to "♪". The generated bubbles are placeholder text (last two characters of
the Chinese name, the shape of the hand-written 蛙草!) and are the only
non-derived thing in that file.

### ⚠ The home PC's `wifi_creds.h` has only ONE network, and it is the home one

Found 2026-07-30 while checking whether the home PC could flash. It can — ESP-IDF
5.4 is at `~/esp/esp-idf` and the device sits on **COM3** — and that is exactly why
this matters: **flashing from home right now would produce an image that knows only
the home wifi**, and the device would fail to join at work the next morning. That
is the 07-27 incident again, whose symptom (stuck on the clock face, button
apparently dead) reads as broken hardware.

**Resolved the same evening.** Both networks are in the home PC's `wifi_creds.h`
now, the image was rebuilt and flashed from home over COM3, and the device rejoined
the home network. Still check the entry count before any future flash: the file is
per-machine, git cannot carry it, and the work PC's copy is a separate question.

**This is independent of any particular change** — it is a standing trap. Anyone
who flashes from home once strands the device at work. Check the entry count
before every flash: `grep -cE '^\s*\{\s*".*",\s*".*"\s*\}' firmware/main/wifi_creds.h`
must print 2.

Also worth knowing, from getting the toolchain to run here: `export.bat` refuses to
run when `MSYSTEM` is set, which it is under Git Bash, and PowerShell's execution
policy blocks `export.ps1` outright. What works is a script file run with
`powershell -ExecutionPolicy Bypass -File`, dot-sourcing `export.ps1` and then
calling `python $env:IDF_PATH\tools\idf.py` — `idf.py` is not directly callable
because `.PY` is not in PATHEXT. Do not change the machine's execution policy for
this.

### The board has 8MB PSRAM — read it from the chip, not from sdkconfig

`esptool` prints it on every connect: `Features: WiFi, BLE, Embedded PSRAM 8MB`.
`CONFIG_SPIRAM_TYPE_AUTO` means the *config* does not name a size, which is not the
same as the size being unknowable — and an earlier note in this file argued from the
config that 2.36MB of pre-synthesized cries "might not fit". It would have fit
easily. Any question about this board's memory can be answered in one connect:

```powershell
python -m esptool --port COM3 flash_id
```

The on-demand change below still stands on its own merits — 2.36MB resident for
something recomputable in microseconds is waste, and it decouples the sound count
from memory permanently — but it was not rescuing the device from anything.

### Cries are synthesized on demand now, and the app partition is 92% full

`synth_all()` became `synth_init()`: one PSRAM buffer sized to the longest sound
(~37KB) instead of one buffer per sound (2.36MB at 156 cries). Built and verified
with `idf.py build`; **not flashed**, see the wifi note above.

`SND_COUNT` had been a literal 21 and the existing `static_assert` caught it when
the table reached 159 — the assert earning its keep. It is derived now, and a second
assert pins the real ceiling: a sound id is a single byte in the PLAY and CONFIG
payloads, so the table can never exceed 255 entries.

**New constraint to watch:** `pokemon_buddy_fw.bin` is 965,392 bytes against a
1,048,576-byte app partition — **8% free**. The 156 note tables are most of the
growth. The next feature that needs flash may have to grow the partition.

### SD card: the pins are not in the board package

`codec_board` already exposes `mount_sdcard()` / `get_sdcard_handle()` /
`get_sdcard_config()`, and `cfg_parse.c` understands an `sdcard:` section with
clk/cmd/d0..d3/power. But **no board in `board_cfg.txt` declares one**, including
this device's `S3_RLCD_4_2` (it has i2c, i2s, out, in and nothing else). So the SD
slot's wiring has to come from the board's own documentation or schematic before
any of that API can be called. Deliberately not guessed: wrong GPIOs here could
collide with the LCD or the codec bus.

Also: the home PC has **no card reader** (no SD device in PnP at all), so copying
files onto the card cannot be done here even with the card out of the device. The
better end state avoids readers entirely — once the firmware can mount the card,
the host can stream files over the existing protocol and let the device write them.

### Two loose ends, deliberately not touched

- **`捕捉` reads 3 but only 1 is real.** The 07-30 work-PC note recorded the true
  state as `捕捉 0`, and `450be1d` stopped `normalizeDex` inventing captures out
  of dex entries — but it does not retroactively strip a `capturedCount` already
  written into the save. Two stale fixture counts are still in there, so tonight's
  single genuine catch displays as 3. Left alone rather than edited: it is the
  owner's save and the correction is theirs to authorise.
- **`pollUsage failed: no-token`** repeats on every tick in
  `out/host-autostart.log` on this machine. The home PC has no usage token
  configured. Harmless to the buddy, noisy in the log, and it means the WEEK bar
  and the 5h/wk figures stay blank here.

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

## Noticed on the work PC, 2026-07-29 — reported, not acted on

Found while getting the machine ready to hand the device over. None of it was
touched, because none of it is what the session was for and three of the four
want a decision rather than a fix.

- **The usage row has no data and never has.** `out/host-autostart.log` has 352
  `pollUsage failed: no-token` and no successful poll — the very first one is on
  line 3 — and `out/usage.json` does not exist on this machine at all. The token
  comes from `readOAuthToken` in `src/usage-poll.mjs`, i.e. Claude Code's own
  credential store, which a host started from the Startup folder may simply not
  be able to read. The statusline fan-out bridge is the other way that file gets
  written and is presumably what has been covering for this.
- **`wifi: remembered address failed repeatedly; falling back to mDNS` × 896**,
  plus 662 of the softer `did not answer` variant. That is the discovery path
  tuned across two sessions and measured at 400 ms remembered-address / browse
  only after 8 misses. It works — the device is on wifi as this is written — but
  that much fallback is not what "remembered address first" is supposed to look
  like. **Unmeasured**: this is a log observation, not a timing, and the wake
  path's own rule is to measure before changing it and to change it on its own.
- **`git ls-remote origin` shows five `claude/*` branches.** The 07-28 note says
  it should show `main` and two tags and nothing else, so that line is now
  stale. They are somebody's working branches; nobody has said they are dead, so
  they were left.
- **`host/nul` is a 466 KB PNG.** A sprite review contact sheet that went to a
  file literally named `nul` — the Windows redirect trap, `> nul` in a shell
  that does not treat it as the null device. Untracked, harmless, and left for
  the owner to delete since it is his review output.

---

## The 151-species pokedex work — where it stands

Three phases are in and green; the rest is not started. Everything so far is
host-side and additive: no firmware change, no change to the wake path, the
transport, or the animator. The device is running exactly what it ran before.

| Phase | State |
|---|---|
| P1 metadata + sprites | **done** — `seed/pokedex.json` (names/types/evolutions/capture rates for 1–151), 156 baked sprites, `species-meta.js` sources all of it. Sprite ink and 20 species names revised 2026-07-29, below |
| P2 save model | **done** — `pet/dex.js`: 已捕获 count (duplicates included), pokedex count (distinct), and a box holding one pet per species, each with its own level and bond |
| P3 encounter engine | **done** — `pet/encounter.js` + a generated condition table |
| P4 notification row + capture screen | **done (2026-07-30)** — rows 3-4 draw the offer and the dex counts, and the capture screen plays. Not yet played on hardware by the owner |
| P5 pokedex screen + swapping the active buddy | **done (2026-07-30)** — all 151 on three pages, a cursor over what you own, a confirm screen, and the swap. Not yet driven on hardware by the owner |
| P6 cries | **synthesized cries done for all 151 (2026-07-30)**, plus the trigger points, all flashed. **Heard on hardware and accepted by the owner 2026-08-03** — see "Still open" #1 for what that does and does not cover. *Recorded* cries are no longer blocked either: the SD pins were measured 07-31 and the card mounts, so that path is open whenever anyone wants it |

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

**The left panel's rows 3 and 4 are in as of 07-30.** They went into the band
`drawLeftPanel` had kept blank and commented `reserved (future notifications)`
since the panel was first drawn, which is where the owner asked for them:

- **Row 3** is one centred line, always present, revised to the owner's spec on
  07-30. With an offer live it reads the fixed `有野生宝可梦出现` and **never
  names the species** — that is the capture screen's to reveal, and there is a
  test asserting two different species render byte-identical. With no offer it
  reads `工作要耐心礼貌哦` or `在家要好好休息哦` depending on the WiFi (below).
  No box, no fill: the blink is a **weight** change, 800 against 400. Zpix has
  exactly two effective weights (≤600 and ≥700 each render identically) and both
  advance the same width, so the text changes stroke without shifting a pixel.
  `encounterBlinkOn()` keys off the animator's `animPhase`, so it needs no timer
  of its own and a still frame (paintFromDisk, the dashboard preview) shows the
  heavy phase.
- **Row 4** is `图鉴 n/151` and `捕捉 n`, always drawn. They are deliberately two
  numbers, not one: `dexCaught` is distinct species and `capturedCount` counts
  duplicates, so a duplicate catch moves the second and not the first. A test
  pins exactly that.

### Which place the host is in, and the two fonts that came with it

Row 3's idle message needs to know whether the host is at work or at home.
`src/place.js` answers it from the **WiFi SSID** (`netsh wlan show interfaces`),
not from the hostname — the machines are fixed today, but the network is what
the question actually means, and a hostname would lie about a machine that
moved. Three things worth knowing:

- **The SSID → place map lives in `config.json`**, which is per-machine and
  untracked, so neither SSID reaches the public repo. Add it once per machine:
  `"places": { "<your ssid>": "work" }` / `"home"`. **The home PC does not have
  its entry yet** — until it does, the row is simply blank there.
- **An unknown or unreadable SSID draws nothing.** No guess: the wrong guess
  tells him to rest at home while he is sitting at his desk.
- **It does not shell out when `places` is empty**, which matters more than it
  sounds. Every test that drives a tick has no `places`, and spawning netsh
  there slowed the tick enough to start losing a *third* main-orchestration race
  on top of the two below. That was the whole cause; the guard removed it.

**Two font decisions.** Row 2's date went to 21px, exactly 1.5x its old 14px, at
the owner's ask. Two consequences:

- **The weekday stayed at 14px.** Both at 21px measure 200px against 193px of
  usable row and collide into `2026年7月30日周四` with no gap — nothing throws,
  the text just runs together. Getting both large needs the year dropped or the
  row split, which is a content decision. `test/left-rows.test.js` now measures
  the widest possible date against the panel so this cannot come back silently.
- **21 is off the Zpix 12px grid and has NOT been accepted on hardware yet.**
  `layout.test.js` keeps a list of approved sizes for exactly this reason (12/24/48
  are grid multiples; 14 was an earlier signed-off exception). Look at the real
  panel: if it reads fuzzy, go back to 14 or up to 24 — 24 is on the grid but
  does not fit without dropping the year.

That guard also had a hole worth remembering: it scans `g.font` template
literals, so moving a size into `const DATE_PX = 21` made it match nothing and
the unapproved size sailed through. It now scans the `_PX` constants too.

**The blink was measured before it shipped, and the worry was wrong.** The
concern was the one the animator section below raises: row 3 sits in the left
panel and the buddy is on the right, so a blink toggle would union the two into
a near-full-frame push at 3Hz. Measured with `out/enc-row-probe.mjs` (untracked,
renders both phases and runs the real `diffRect` over them):

| Frame | Rect | Bytes |
|---|---|---|
| idle, buddy bob only | 152x150 | 2850 |
| encounter up, same blink phase | 152x150 | 2850 |
| **the blink toggle frame** | 312x40 | **1560** |
| full frame, for scale | 400x300 | 15000 |

The toggle frame is *cheaper* than an ordinary animator frame — it is a short
wide band, not a tall union — so the blink costs the transport nothing worth
having. Re-measure with that script if the row ever moves vertically, since the
whole result depends on row 3 and the sprite's top edge sharing a y range.

**Drawing row 4 immediately found a bug, which is the argument for drawing
things.** The panel came up reading `图鉴 2/151 · 捕捉 2` on a buddy that had
hatched and evolved once, with an empty box and no capture flow implemented at
all — `recordCapture` has no caller outside `sim-encounters.mjs`. `normalizeDex`
was flooring `capturedCount` at `dexCaught.length`, on the reasoning that a dex
entry implies a capture. `recordSeen` exists precisely to break that: it unlocks
the starter line's entries, which are owned and explicitly *not* caught. The
floor is now `box.length`, which is true by construction — nothing but a capture
puts anything in the box.

The number had already been persisted, so the live save on the work PC was
corrected by hand once (`capturedCount` → `box.length`, undo copy left at
`out/state.json.precapfix`). That is a one-off, deliberately **not** a
migration: once capture ships, resetting the count on load would be a bug of its
own.

**What is left is the capture screen** and the button that answers it. Until it
exists, an offer can appear and expire and the only thing that ever happens is
row 3 blinking — nothing can be caught yet, so `捕捉` correctly stays at 0.

### The pokedex screen (2026-07-30)

All 151 in dex order, 10x6 to a page, three pages. Caught entries are the same
line art the buddy panel draws; the rest are **solid silhouettes** — the owner's
call, taking the classic look and accepting that it gives every shape away at
once. `src/render/dex-screen.js` renders, `src/pet/dex-view.js` is the state.

**The gestures, and why.** `KEY` double opens it — it was the one gesture the
firmware sends, the dispatcher already queued, and *nothing consumed*. Inside,
short turns the page (wrapping), long returns. **BOOT is not touched**: it
belongs entirely to power-save, and borrowing it is the mistake that stopped the
radio on 07-27 with a symptom that read as dead hardware. A test asserts BOOT
does nothing to the screen in either state.

**It is on the dispatcher's immediate path, not the tick's.** Routing a button
through a 60-second tick would mean pressing KEY and waiting up to a minute — a
delivery, not a screen. The signature animation already lives on that path for
the same reason, and the pokedex branch is checked *before* it so an open screen
is not painted over by a greet the press never meant.

**Three things hold the panel steady while it is up**, and all three have tests
because each one fails silently:

- the animator is paused on open and resumed on close, exactly once — page
  turns must not stack pauses;
- the tick still runs in full (bond, settlement, encounters, the save all
  matter whether or not anyone is looking) but skips its `push`, via
  `runOneTick`'s `shouldPush`;
- a render that throws closes the screen and unparks the animator, because the
  alternative is a panel frozen on the last frame forever.

**It closes itself after ~3 idle ticks.** An open screen holds the animator
paused and swallows the greet gesture; walking away should not cost either.

**The silhouette is a flood fill, and the obvious version does not work.** The
first attempt inked "anything that is not paper", which renders every entry
identically — these sprites are line art on *transparency*, so a figure's
interior composites to exactly the same white as the page around it. There is no
"inside" to test a pixel for. `fillOutline()` floods the background inward from
the border instead and inks whatever it could not reach. That depends on the
outline being closed, which is why the downsample is a **box filter** rather
than nearest-neighbour: it thickens every stroke and seals the hairline gaps
that open when a 155px drawing is sampled to 36. A figure that still leaks comes
out as line art instead of a shadow — wrong, but visibly wrong.

**The lit cells are thinner than the shadows are, on purpose and by a different
rule.** The owner asked for this the same day: the first version fattened every
1px line into a 1:4 box and the grid read as bold. `LIT_COVERAGE` (0.18) is how
much of a source box must be ink before a lit pixel is ink; the silhouette path
keeps demanding only *any* ink, because that fattening is precisely what seals
the outline `fillOutline` needs. 0.18 was chosen by looking —
`out/dex-thin-sweep.mjs` renders a spread of body types across a range, and
damage starts around 0.26 where dratini and magikarp begin dropping strokes.

**This lives entirely in `dex-screen.js`.** It is not the `BOOST` table, not
`HALF_BOLD`, not `dilateHalf`, and not the full-size buddy sprite — all of which
were tuned over eight review rounds and stay exactly as they were. Anything that
wants to change how a pokemon looks *at 36px in the grid* belongs here; anything
that changes how one looks anywhere else does not.

**Cell size was chosen by looking.** `out/dex-grid-probe.mjs` renders a page at
several sizes; at 30px the line art collapses into blobs, at 36px the species
stay apart. 10x6 also makes the grid position readable as the dex number — row 1
of page 1 is 1-10.

Cells are cached per species *and* state (the two renderings are different
bitmaps), which is what makes a page turn 12ms instead of 190ms. `out/dex-screen-probe.mjs`
has those timings and the page-turn dirty rect (13KB — near a full frame, but
only on a press, never continuously).

### Swapping the buddy, and the keepsake rule (2026-07-30)

**The cursor walks the roster, not the grid.** Stepping cell by cell would be
151 presses to reach the end and all but a handful of stops would be a
silhouette that cannot be picked anyway, so KEY short hops between the species
actually owned, in dex order, and the page follows the cursor. `pageForCursor`
derives the page rather than storing it beside the cursor, so the two cannot
disagree about which page the cursor is on.

Gestures inside the screen, set by the owner 2026-07-30: **KEY short** moves the
cursor, **KEY long** turns the page, **KEY double** opens the confirm screen,
**BOOT short** returns to the buddy panel. On the confirm screen, **double**
commits and **short** cancels — the swap is the one irreversible thing in here,
so it takes the deliberate gesture and the easy one backs out.

### The BOOT rule, whole (owner, 2026-07-30)

BOOT is now the navigation button, and the three rules fit together:

| Where you are | Gesture | Goes to |
|---|---|---|
| any host screen (pokedex, confirm, capture) | **BOOT short** | the buddy panel |
| the buddy panel | **BOOT double** | the device's own clock face |
| the device's own clock face | **BOOT short** | the buddy panel |

**Only the first row is host code.** The other two are already the firmware's
behaviour and were not touched: `enter_local_clock_mode` on BOOT double, and
"ANY BOOT press gets you out" on the way back (`main.cpp`). That the owner's
rules and the firmware's agree is luck worth noticing — it means the whole
scheme needed no reflash.

It also means **BOOT short is the only gesture the host may take.** BOOT double
is spoken for device-side: the firmware acts on it *by itself*, stopping the
WiFi radio before the host hears anything. A host screen that returned on BOOT
double would exit into power-save with the radio off and no link left to paint
back over. Tests pin that BOOT double and BOOT long still pass straight through.

**Backing out of a capture is navigation, not an outcome.** BOOT short during
the capture screen leaves the offer standing — nothing was thrown, so nothing
fled, and coming back within `offerMs` finds the same pokemon there. It is the
one session result that queues nothing.

Because the page is now turned by hand, the **cursor is scoped to the page** it
is on rather than to the whole roster: turning to a page holding nothing you own
simply leaves no cursor, and the whole 151 stays browsable. A new page starts
the cursor over — index 3 of one page has nothing to do with index 3 of the
next.

The cursor is drawn as **corner brackets around** the cell, not as an inversion
of it: half the cells are solid silhouettes, and inverting one would turn the
highlight into a hole.

**The keepsake rule, which is the owner's and is the interesting part.** You may
display any species you own — including one you have already evolved past — but
a form you have evolved past does not live. It shows `Lv -`, an empty exp bar
and five empty hearts, and it earns nothing.

The test is **"do I own something this evolves into"**, not "does this evolve".
That distinction matters: a wild charmander you have never evolved is perfectly
alive, and only 妙蛙种子 is frozen because 妙蛙草 is in the dex. Owning a
*distant* descendant freezes the base form too, so skipping a middle stage does
not leave a live duplicate behind.

**Growth is pinned, not skipped**, and that is deliberate. `applyDailyGrowth`
and `applyBondTick` still run for a keepsake and their result is then reverted
(`pinFrozenGrowth`). Skipping them outright would freeze the day anchors
(`lastGrowthDay`, `todayCreditedExp`) as well, and a later swap back to a live
buddy would then let it claim a whole day's exp it did not earn — which is the
same bug the anchors exist to prevent for a newborn. Transitions ARE skipped
outright, because that is where evolution happens and a form already evolved
past must not offer to evolve again.

**The swap carries a short list on purpose**: species, level, exp, bond,
personality, caughtAt. Everything else — `lastGrowthDay`, `lastSettled`,
`todayCreditedExp/Bond`, `bondDay`, `bondHalves`, `streak`, `shield` — is the
*trainer's* day bookkeeping and stays put. Carrying a week-old set in from the
box would make the incoming pokemon either settle a week it did not live through
or claim a day it did not earn. Leaving them alone means a boxed pokemon is
simply paused, which is also what it looks like from outside.

Swapping away and back returns the *same* pokemon, levels and nature intact —
there is a test for exactly that round trip, because it is the property that
makes the box a shelf rather than a shredder.

`caughtAt` is stamped in `applyCaptureResults`, the one place a capture becomes
real. Anything that entered the dex through `recordSeen` (the starter line) has
no box entry and therefore no date, and the confirm screen shows `--`.

### Testing it without waiting: out/arm-encounter.mjs

Untracked fixture. Puts a wild pokemon on offer immediately so the capture
screen can be exercised without waiting for the engine to roll one:

    node "C:\Users\zy948\claude-pokemon-buddy\host\out\arm-encounter.mjs"        # 皮皮
    node "C:\Users\zy948\claude-pokemon-buddy\host\out\arm-encounter.mjs" abra   # any dex key

It resolves the save from its own location, so it runs from any directory and
any shell. It used to use a relative path, and from the wrong folder that threw
ENOENT — which, launched from a terminal button, looks exactly like nothing
happening.

**It marks the offer `test: true`, and a marked encounter records nothing** — no
tally, no dex entry, no box copy — while still consuming the offer, since
rehearsing the whole flow is the point.

**That flag has to be listed in `normalizeEncounter` (`state.js`), and this is
the trap.** That function rebuilds the encounter from named fields on every
save/load, which is the right discipline for a field that drives a cooldown
clock — but it means a flag merely *carried* on the object is silently dropped
between the fixture writing it and the tick reading it. Five test catches went
into the real collection that way before anyone noticed, and the save has been
corrected by hand twice (`out/state.json.pretestfix`, `.pretestfix2`). There is
a test pinning the round trip now.

### Three throws, and the HP bar (2026-07-30, the redesign)

The single-throw version lost to button latency, so an encounter is now:

    throw 1   attack      throw 2   attack      throw 3+  capture

**A does not move for the whole encounter, retries included.** That is the fix,
not a detail. By the third throw you have watched the same target twice and know
how early to press; difficulty stops being "guess the lag" and becomes "do not
panic on the last one". The first version re-rolled A each throw on purpose, to
stop a failed timing being replayable — exactly backwards for what was needed.

**The HP bar** sits at the top. It starts at `HP_MAX` and attacks take it down:
B a half, C a third, a clean miss nothing. **Attacks can never take the last
point** — one clamp, and it is what makes "the second B does half-minus-one"
fall out on its own instead of being a special case. Two B hits land on exactly
1, which is the state the forgiving capture needs.

| capture lands | result |
|---|---|
| **B** | caught, however the attacks went |
| **C** | caught **iff HP is 1** (i.e. both attacks hit B), else retry until B |
| **neither** | flees, however the attacks went |

Checked against the owner's own shorthand, which `test/capture-rules.test.js`
writes down almost verbatim: `B+B+either = 1`, `B+C+B = 1`, `B+C+C = retry`,
`B+B+N = 0`, `C+C+B = 1`, `C+C+C = retry`.

**`HP_MAX` is 12, and the size is forced rather than chosen.** The rules need
`HP_MAX - (a B hit) - (a C hit) > 1`, or B+C would leave exactly 1 and a
C-capture after it would succeed — contradicting `B+C+C = retry`. That needs
`HP_MAX > 6`, and the halves and thirds need it divisible by 6. Twelve is the
smallest that is both. **Six would silently break the owner's table**, which is
the sort of thing that looks fine until someone plays it.

**A missed attack costs the shortcut, not the encounter.** It does no damage, so
HP never reaches 1, so the capture then has to be a clean B. Only the capture
throw can end things badly.

**凯西 (abra) is the one exception**: one throw, and it is the capture, because
that is its whole character in the games. Anything but B and it is gone — no
retry. `TELEPORTERS` lives in `capture-tuning.js` so `capture-rules.js` can stay
species-free; it takes the behaviour as a boolean, never a name.

**The screen has no time limit.** The owner's call: `offerMs` governs how long
the *notification* stands, not how long you may aim. The only ways out are an
outcome or BOOT short. Two consequences worth knowing: the encounter tick is
**held still** while a capture is on screen (`holdEncounter`), so the engine
cannot expire or replace the offer under a player mid-throw; and an abandoned
capture screen holds the panel indefinitely, since nothing times it out.

### The capture screen, as first specified on 2026-07-30

Written down because it came from him in conversation and nothing else records
it. The order he asked for is **rows 3-4 (done) → the pokedex screen → the
capture screen**, so the pokedex screen comes first even though this is the more
interesting one.

*The animation*: a ball is thrown, hits the pokemon, the ball wobbles on the
ground, and stars come off it on a success. Explicitly the classic GBA look —
early-generation pixel art is the reference, not something new.

**Superseded on the same day — see "Three throws" below.** The single-throw
version was built, played, and failed on *button latency*: one press against a
narrow window is a guess, not a skill. The bar, A, B and C all survive; what
changed is that there are now three throws and the first two are practice.

*The original mechanic, which is his own rather than the games':*

- A horizontal bar spans the bottom of the screen.
- A vertical line **A** sits at a random position in it, and does not move.
- A segment **B** slides left and right inside the bar. **C** is B extended
  symmetrically on both sides; B and C slide together as one piece.
- **Length and speed vary by species** — this is where a rare one is made hard,
  rather than by a hidden capture rate.
- KEY stops the slider. Then, by where A falls in the stopped piece:
  - **inside B** → caught.
  - **inside C** → the throw fails, but the pokemon does **not** flee: you go
    again, and keep going until A lands in B.
  - **outside both** → it escapes immediately and the encounter is over.

How a species maps to its B/C width and slide speed was **decided on 07-30 and
deliberately is not written here** — it is part of the same surprise the
encounter table is, so it lives in `src/pet/capture-tuning.js`, which is a
**fourth spoiler file** alongside the three listed above. Read it before
touching difficulty; do not re-derive it, and keep it out of chat.

### How it is built (2026-07-30)

- `src/pet/capture.js` — the mechanism: where the slider is at time *t*, and
  what a throw then does. Pure, and **species-free on purpose**, exactly like
  `encounter.js`: it can be read and reviewed without learning anything.
- `src/pet/capture-tuning.js` — **spoiler.** Species → difficulty.
- `src/pet/capture-session.js` — the loop. Every side effect is injected
  (clock, sleep, push, render), so the tests run a five-minute offer in
  microseconds with no device.
- `src/render/capture-screen.js` — the frames. Throw arc, wobble, sparkle,
  flee.

**KEY double is context-sensitive**, and row 3 tells you which you will get:
with an offer live it opens the capture screen, otherwise the pokedex. There was
no second gesture to spend — BOOT is power-save's, and KEY short/long are the
greet and the evolution confirm.

**The frame rate was measured before the design leaned on it.** A slider that
cannot animate smoothly is not a timing game. `out/capture-probe.mjs`: a frame
renders in **6.2ms**, and one 50ms slider step dirties **304 bytes** — against
2850 for a single buddy-bob frame the animator already pushes three times a
second. So 20fps costs the transport *less* than the idle buddy does, and
`FRAME_MS` is 50.

**The difficulty bands are sized in milliseconds, not pixels**, and that is the
part worth not undoing. What the player controls is *when they press*, so a
band is worth however long the slider spends inside it. The first tuning sized
them by appearance and produced a hardest tier where B was worth 17ms — shorter
than the button's own latency, i.e. luck wearing a skill costume. They now run
500ms (easiest) to 107ms (hardest) inside B, with C giving ~300ms of second
chance even at the hardest.

**Unmeasured, and the first thing to check:** nobody has played it. If the hard
end is luck rather than timing, lower the speed before widening B — widening
first makes the easy end trivial.

**The screen never writes the save.** It returns a verdict, the tick applies it
(`applyCaptureResults`), and there is exactly one writer no matter how the
minigame ends — the same reason evolution choices go through a queue. The visible
cost is that `捕捉` on the panel can lag a catch by up to one tick; the screen
itself says `捉到了！` immediately, which is where it matters.

Every outcome clears the offer, not just a catch. Leaving it up after a miss
would let the same pokemon be thrown at again, which is the opposite of fleeing.

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

**Four files are spoilers and the owner has asked not to see them:**
`host/scripts/gen-encounters.mjs`, `host/seed/encounters.json`,
`host/scripts/sim-encounters.mjs` (its output names species), and
`host/src/pet/capture-tuning.js` (added 07-30 — species → capture difficulty). They hold which
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

### Sprite ink and species names, revised 2026-07-29 (work PC)

Owner reviewed all 151 on screen across three passes and flagged 35 sprites
plus 20 names.

**35 sprites re-baked.** All but two were the same defect the `slowpoke` entry
already described: a mid-tone body fill sits below the calibrated threshold, the
sprite arrives as a filled silhouette, and the linework that should define the
shape is gone. They now carry explicit `BOOST` values (mostly 0 or -10;
`alakazam` -20, `bellsprout` -20, `dratini` -30, `marowak` -30).

`shellder` went the other way — +80, because its pupils are small dark dots
inside already-dark eyes and threshold away entirely below +45, leaving it
staring blankly.

`rattata` is the one to learn from: -10 cleared its body and took its front
teeth and mouth line with it, and that only surfaced on the owner's next review
pass. On a sprite whose detail is drawn in thin mid-tones, judge the face, not
just the body. It sits at 0.

**gastly gets its own bake path** (`BANDS` + `bakeDWBands`), because one
threshold provably cannot do what was asked: the gas should be black and the
head should not be a solid disc, but the gas is *lighter* than the head, so any
cut that reaches the gas has already filled the head. Measured levels in the
rendered grey are 48 linework / 68–74 head fill / 87 gas / 255 paper and eye
whites (`out/gastly-bands.mjs` dumps this), so inking the darkest band plus the
gas band and leaving the head fill white gives a white line-art head inside a
solid cloud. Those cuts are absolute and tied to this specific artwork.

An earlier attempt at gastly used a `MAX_INK` override instead. That is gone —
it produced the solid black disc the owner rejected. Do not reintroduce it.

The 0.34 blob guard in `test/sprites.test.js` is unchanged for everything else;
gastly gets a two-sided window (0.22–0.36, it lands at 0.298) rather than an
exemption, so a clipped cloud and a re-filled head both still fail.

Values were chosen by sweeping each species and looking at the output, not by
reasoning about the artwork — the ladder is not monotonic, because past a point
the outlines themselves break into dashes. The sweep helper is untracked at
`host/out/boost-sweep.mjs` (with `review-sheet.mjs`, which composites the
black-on-transparent PNGs onto PAPER white so they can be judged at all).

**20 species renamed to their pre-unification Chinese names** — owner's
preference, `OLD_ZH` in `scripts/gen-pokedex.mjs`. It lives in the generator
rather than as a hand-edit of `seed/pokedex.json` precisely so a re-run does not
silently revert them; PokeAPI is the only other source of that field. A full
regenerate was done and diffed: exactly 40 lines changed, all of them `zh`.
All 20 were rendered through Zpix at 12/24px and checked — `3D龙` is the only
name in the dex mixing ASCII with CJK and it renders fine (27px wide at 12px,
narrower than a three-hanzi name); the longest is still 52px, unchanged.

**Bold was tried and rejected — do not bring it back casually.** Pulling a
threshold down also thins every stroke, and past a point that reads as washed
out (the owner's word: 过度曝光). One pixel of dilation at bake time fixed that,
but it closed up the fine detail on zubat, venomoth and kabutops and the owner
rejected it outright. Two lessons, and the second is the real one:

- it was applied to **all 41 species with a lowered threshold**, not the six
  actually reported as washed out. Fixing more than was reported is how a fix
  turns into a regression on sprites nobody had complained about — kabutops was
  the one he noticed, and he was right to ask why it had changed at all.
- `dilate1bpp` and `drawSprite`'s `bold` option still exist for their original
  purpose. `BOLD_LINE_SPECIES` is still empty. If bold ever comes back it needs
  a per-species list somebody has looked at, not "everything I touched".

A **half-weight** version was then approved and is live: `dilateHalf` +
`HALF_BOLD`, currently eleven species. Half grows ink right and down only, so a
1px stroke becomes 2px instead of 3px and a gap closes only if it was 1px wide
*and* on the growth side — the faux-bold trick, not a morphological dilation.
Measured on zubat that is ink 0.130 → 0.195 → 0.225. `out/bold-levels.mjs`
renders none / half / full side by side; use it before adding to the set, and
keep the set to sprites somebody has looked at both ways.

**The bake draws a few things the artwork does not contain** — `PUPILS` +
`stampDot` for pupils, `STROKES` + `stampLine` for linework. These species are
drawn with an eye ring and nothing darker inside it, so no threshold and no band
can produce a pupil (`out/bands.mjs` shows the level is simply not there), and
rattata's incisor has no left or top edge at its threshold so the tooth runs
into the muzzle. The owner asked for both rather than move to artwork he liked
less. Final set: pupils on magikarp, koffing, kingler; the tooth edges on
rattata. Tried and **rejected**: butterfree, hitmonlee, beedrill — on hitmonlee
the white inside the eye is only 3x5px, so the dot filled it and changed
nothing visible.

Coordinates come from the **colour source at bake scale**, via
`out/eye-locate.mjs` (renders the artwork with a grid and clusters a colour) or
`out/eye-measure.mjs` (finds the enclosed hole an eye ring makes). Do not read
them off the 1-bit render: the first pair was done that way, landed low and
right of both eyes, and missed butterfree's second eye entirely because at
1-bit it is a 10px sliver that reads as a stray line. `stampDot` and
`stampLine` throw on an out-of-bounds coordinate, but neither can tell that a
reworked upstream drawing moved the feature — **re-measure if a sprite with an
entry here is ever re-sourced.**

*Replacement artwork.* `ALT_ART` moves ten species off the dream-world set,
because no threshold fixes something that is not in the source file:
`weepinbell` has no body spots there; `vulpix`'s eye is an empty ring at every
threshold from +100 down; `pidgey` has no linework layer at all, just two flat
fills; `rattata` is gradient-shaded rather than flat, so its front teeth never
resolve. `pikachu`, `raichu`, `persian`, `diglett`, `dugtrio` and `dratini` were
owner preference rather than a defect in the file. `out/alt-art.mjs` renders a
species across every set PokeAPI carries.

`jigglypuff` and `butterfree` joined `BANDS` for the same reason as parasect,
applied to eyes: their pupils are a distinct level *lighter* than the linework
(137-140 and 121), so any single cut that keeps the body white loses them.
`koffing` was checked the same way and has no pupil level in any set — its
dream-world art draws narrowed smiling eyes, so there is nothing to recover.

`blastoise` was moved to the gen-5 game sprite and moved straight back — pixel
art next to 150 illustrations was rejected on sight. It is on dream-world at the
default and no illustration set does better. Known-mediocre, leave it.

`parasect` joined `gastly` in `BANDS`, from the other direction: its cap spots
are *lighter* than the cap, so one cut gives either a black cap with white spots
or a white cap with no spots. Inking the linework and the spot band gives a
white cap with black spots. `out/bands.mjs` dumps any species' paint levels and
is the tool for deciding whether a species needs this.

**Three species have no good answer from any source, and that is a finding.**
`out/bands.mjs` is what settles it: if a species' art has no dark plateau, there
is no linework layer in the file and no threshold will invent one.

- `pidgey` and `magmar` are flat fills with no outline layer at all. pidgey was
  fixable by switching art; magmar is not — every set is worse, official-artwork
  most of all (heavy painted shadow turns to blotches and dashed contours). It
  sits on dream-world at +10, which is legible with a solid black crest. Best
  available, not good. Owner has been told.
- `rattata` is gradient-shaded (one band spanning grey 67-105), so its front
  teeth never resolved at any threshold. Fixed by artwork, not by tuning.
- `blastoise`: see above.

**Still open, not acted on.** The same filled-body look is visible on others the
owner has not ruled on — most clearly `tauros`, `drowzee`, `weezing`, `krabby`,
`kingler`, `rapidash`, `moltres`. Left alone deliberately: several of these are
genuinely dark in the source art, and this list only grows when a sprite is
looked at and judged wrong.

**Asked and answered once, so do not re-litigate it:** the owner asked whether
the whole dex had been given a global exposure change. It had not — the default
is still `boost 25` / `maxInkRatio 0.30`, untouched, and only species with an
explicit table entry differ. Of #122 and up, eight were tuned; the other
nineteen are exactly as first baked.

---

## Per-machine setup that git does NOT carry

| File | Why untracked | Notes |
|---|---|---|
| `firmware/main/wifi_creds.h` | WPA passphrases, public repo | must list **every** network — see below |
| `host/config.json` | name/location/volume/token/saveSync | `name` is the **owner's name only** (`Hughie`); the panel composes 名字的物种 itself |
| `host/out/state.json` | the save | synced now, see `docs/save-sync.md` |
| `start-buddy.vbs` | absolute paths | autostart launcher |
| **git `user.name` / `user.email`** | not a file, but git does not carry it either | **required for save-sync to publish at all.** `git commit-tree` refuses without an identity and the failure only shows up in `out/host-autostart.log`. Set it repo-local; see the 07-28 session record above |
| `host/seed/sprites/`, `host/seed/oak.png` | Nintendo artwork, public repo | **new 2026-07-28** — run `cd host && node scripts/bake-assets.mjs` once per machine (~156 files, a few minutes). Without it the buddy renders as a checkerboard placeholder and the sprite tests skip themselves. **Re-bake after 2026-07-29**: the ink table changed for 22 species and a stale sprite is a valid PNG that just looks wrong, so nothing warns you |

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

`save-sync-cli.mjs status` answers all of this out loud as of 07-29: it prints
the remote's save beside the local one and names the direction, including the
do-not-pull case above. It writes nothing, so it is always safe to run first.
Backed by `sync.peek()`, which shares `pull()`'s fetch and marker check and has
a test pinning that it leaves the save and the `.presync` copy alone.

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
| `sd-probe-read.mjs` | listens for `#CPB` lines and retries the open while the USB device re-enumerates. Run it right after `esptool --after hard_reset`; it never touches DTR/RTS itself. Also decodes `T_OFFLINE` frames (2026-07-31) |
| `offline-bond-listen.mjs` | builds the **real** serial transport and prints its `onOfflineBond` events — proves the host's own parse path, not a hand-rolled one (2026-07-31) |

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
| Work PC, `7d2b799` + sprites, 07-29 | 506 pass / **12** fail of 518 | **no — see below** |
| Work PC, P4 + sprites merged, 07-29 | 519 pass / 11 fail of 530 | with `--test-force-exit` |
| Work PC, this commit (+ `peek`), 07-29 | 523 pass / 11 fail of 534 | with `--test-force-exit` |

The steady 10 are the 9 platform failures plus the RM12 flake. **Two more are
load-dependent** and appear only sometimes on the home PC:

- `main logs pollUsage failures once per reason transition`
- `main resolves when SIGINT stops the loop during its sleep (RH2)`

Both pass when `main-orchestration.test.js` runs on its own, and fail under
`--test-concurrency=4` on a machine slow enough to lose the race. Anything
outside these twelve is real.

The last row is the merged tree — the home PC's P4 work and the work PC's sprite
work together, run on the work PC. The count matches the home PC's 530 exactly,
and the eleven are the nine platform failures plus those two; RM12 happened to
pass that run. So the two sessions do not interact: nothing here is new.

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

**Work PC, 07-29 — the same hang, one degree worse, plus a workaround.** It
reproduced here exactly as described, including both load-dependent failures and
the identical 506/12 of 518, which is now measured independently on two machines
and two trees. Two things to add:

- **It can eat the rest of the suite, not just the exit.** On this machine the
  runner never started any file after `main-orchestration` alphabetically —
  `mock` through `wifi`, more than half the suite — so there was no summary at
  all, just silence. "Hangs after printing the summary" is the mild version;
  do not read a stalled run as "nearly done".
- **`--test-force-exit` makes the suite usable today**, and is what the 506/12
  above was measured with:

  ```powershell
  node --test --test-concurrency=4 --test-force-exit "test/*.test.js"
  ```

  Same file run alone with that flag: **13/13 pass in 4 s**, which is the other
  half of the evidence that this is an unclosed handle and not a stuck test.

Two dead ends, so nobody repeats them: the `createServer` bound by the
EADDRINUSE test is closed in a `finally` and is not it, and importing the test
file in-process (to read `process.getActiveResourcesInfo()`) does not reproduce
the hang at all, so the handle belongs to the runner's child process.

One consequence worth knowing: an abandoned run leaves `node --test` alive
holding the tree. One was found here still running **five hours** after it
started. `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` lists them —
kill those, and leave the one whose command line is `src\index.js`, which is the
buddy host.

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
