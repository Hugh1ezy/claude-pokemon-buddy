# Handoff — picking this up on the other machine, or in a fresh session

Rolling note between the home PC and the work PC. Last updated **2026-07-30
(WORK PC)**.

> **The 07-29 handoff never happened.** The device went home on the evening of
> 07-29 and came back to the work PC on 07-30 without the home PC being touched:
> no pull, no re-bake, no restart. So **the home checklist below is still
> outstanding, exactly as written** — it was never consumed, and the home PC is
> still on pre-`fcd7e60` code with stale sprites. Nothing was lost by the delay;
> the device never attached to the home host, so no second buddy started
> accruing.

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
| `origin` | `Hugh1ezy/claude-pokemon-buddy` — the fork, **public**, code lives here |
| `upstream` | `aquamarinz/claude-pokemon-buddy` — original, read-only |
| `save` | `Hugh1ezy/cpb-save` — **private**, holds only `state.json` (`docs/save-sync.md`) |

Buddy as of this note: **妙蛙种子 (bulbasaur) 慢性子, Lv.18, exp 20.38, bond 21.6,
streak 5**, published to `save` from the **work PC** on the morning of 07-30 and
verified identical against the remote. Same lineage throughout — the nature has
matched at every check, so the two-buddy trap below has not recurred. The home
PC's setup is complete and its host is running, but it has not held the device
since 07-28.

---

## ▶ What the HOME PC has to do, in order

```powershell
cd "$HOME\claude-pokemon-buddy"
git pull
cd host
node scripts/save-sync-cli.mjs status   # both saves + which way to sync, no writes
node scripts/save-sync-cli.mjs pull     # ⚠ replaces the local save
node scripts/bake-assets.mjs            # required this time -- see below
```

`status` actually shows the remote's save as of 07-29 — it printed only the
remote's *name* before, so the "stop if the remote is behind" instruction below
could not be followed. Expect it to say the remote holds a turn this machine did
not take, and to recommend the `pull`.

1. **Take the synced save — but only once the device is actually at home.** The
   work PC has held it continuously since 07-28 and publishes on every change,
   so `pull` is the right direction and `push` is not. The replaced file lands
   at `state.json.presync` as a one-step undo (deliberately not `.bak`, which
   `loadState` falls back to). Steps 2-4 do not depend on the device and can be
   done any time.
2. **Re-bake the sprites — not optional this time, even though this machine has
   baked before.** The `BOOST` table changed on 07-29 for 22 species, so an
   existing `seed/sprites/` is stale for those and *nothing in git will tell
   you*: the images are untracked, and a stale sprite is a valid PNG that simply
   looks wrong. A plain `node scripts/bake-assets.mjs` re-bakes all 156 and is
   the safe move; re-baking only the 22 is possible by passing their keys
   (`node scripts/bake-assets.mjs gastly rattata`). It takes a few minutes.

   **The bake is deterministic** — verified on the work PC 07-29 by re-baking
   two species and diffing the checksums, which came back byte-identical. So a
   re-bake is safe to run at any time, and `md5sum` against the other machine is
   a real check that two machines are showing the same buddy. It does need the
   network: the artwork is fetched from PokeAPI, not stored.
3. **Restart the host** so it picks up the pulled code — and mean it. The work
   PC skipped this for two days and spent them running an engine-less tick; see
   the note at the top. Nothing else is needed: the home PC already has its
   `config.json` and its `wifi_creds.h`.
4. **No reflash.** Nothing since 07-28 has touched `firmware/`.

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
| P4 notification row + capture screen | **rows 3-4 drawn (2026-07-30)** — the engine has been wired into the tick since 07-28 and encounters persist; the left panel now shows the offer and the dex counts. The capture screen is the remaining piece. See below |
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

**The left panel's rows 3 and 4 are in as of 07-30.** They went into the band
`drawLeftPanel` had kept blank and commented `reserved (future notifications)`
since the panel was first drawn, which is where the owner asked for them:

- **Row 3** is the encounter notification, drawn only while an offer is live. It
  alternates between an inverted box and an outlined one rather than between
  drawn and blank — a row that vanishes for half its cycle can be missed
  entirely by glancing at the wrong moment, and this one has `offerMs` (5
  minutes) to be noticed in. `encounterBlinkOn()` keys off the animator's
  `animPhase`, so it needs no timer of its own and a still frame (paintFromDisk,
  the dashboard preview) shows the loud phase.
- **Row 4** is `图鉴 n/151` and `捕捉 n`, always drawn. They are deliberately two
  numbers, not one: `dexCaught` is distinct species and `capturedCount` counts
  duplicates, so a duplicate catch moves the second and not the first. A test
  pins exactly that.

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

**What is left is the capture screen** and the button that answers it. Until it
exists, an offer can appear and expire and the only thing that ever happens is
row 3 blinking — nothing can be caught yet, so `捕捉` stays at 0.

### The capture screen, as the owner specified it on 2026-07-30

Written down because it came from him in conversation and nothing else records
it. The order he asked for is **rows 3-4 (done) → the pokedex screen → the
capture screen**, so the pokedex screen comes first even though this is the more
interesting one.

*The animation*: a ball is thrown, hits the pokemon, the ball wobbles on the
ground, and stars come off it on a success. Explicitly the classic GBA look —
early-generation pixel art is the reference, not something new.

*The mechanic*, which is his own rather than the games':

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

Note what this does to `seed/pokedex.json`'s capture rates: they stop being the
mechanism. Either they become the input that sets B and C's width and speed, or
they go unused — worth deciding deliberately rather than leaving both in.

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
