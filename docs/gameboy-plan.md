# Running a Game Boy on the buddy — plan

Written 2026-07-31, to be executed once the parts arrive. Nothing here is
started; the buddy is unaffected until phase 3.

**It is Game Boy (DMG), not Game Boy Advance.** GBA is 240x160 at 15-bit colour
with dedicated tile/sprite hardware; this panel is 400x300 and **1-bit**, so
there is no honest way to show a GBA frame on it. That is a display fact, not a
CPU one, and no amount of work changes it. Everything below is about the
original Game Boy.

## What is already measured

None of this is assumed — the numbers were taken on the device on 2026-07-31
and the probes were removed again (`docs/handoff.md` has the raw output).

| | |
|---|---|
| Full panel flush, `RLCD_Display()` | **11.75 ms** avg over 20 (~85 fps ceiling) |
| Panel | 400x300, 1 bit per pixel |
| Flash | 16MB. App partition 4MB, ~3MB free. ~12MB unallocated |
| PSRAM | 8MB octal |
| Buttons the MCU can see | **two** — KEY (GPIO 18), BOOT (GPIO 0) |
| PWR button | **invisible to software**; wired to the power path, not the MCU |
| Free GPIO on the header | 1, 2, 3, 17 (13/14 are I2C, 19/20 USB, 43/44 console) |
| TF card | works, 1-bit SDMMC, CMD 21 / CLK 38 / DATA 39 |

## The two things that make it plausible

**Timing.** A Game Boy frame is 16.7 ms at 60 fps. The flush alone eats 11.75 ms
of that, leaving ~5 ms for emulation — not enough. At **30 fps** the budget is
33 ms, leaving ~21 ms per frame, which is comfortable for a DMG core on a
240MHz dual-core part. So: target 30 fps, and treat 60 as out of scope.

**The 1-bit panel is not a compromise here, and this is the nice part.** DMG has
exactly **four** shades. 160x144 doubled is 320x288, which fits inside 400x300
with room to spare — and at 2x, every Game Boy pixel becomes a **2x2 block of
panel pixels**, which can be 0, 1, 2, 3 or 4 pixels black. Five levels for four
shades. So the four greys map **exactly**, with no dithering pattern, no
temporal flicker, and no loss. A 1-bit display at exactly 2x is the one case
where DMG's palette survives intact.

Pick the four fill patterns so that adjacent shades differ by one pixel and the
lit pixels are diagonal rather than side-by-side, so flat areas read as texture
rather than as stripes.

## What has to be bought, and why

The device has two usable buttons and a Game Boy needs eight (d-pad 4, A, B,
Start, Select). PWR is not a third — that was measured, not assumed. So the
buttons have to come from outside.

### Already chosen (all correct)

| Part | Note |
|---|---|
| **MCP23017 I2C I/O expander module** | 16 inputs on the existing I2C bus, costs **zero** free GPIO. ⚠ **VCC to 3.3V, never 5V** — it shares SDA/SCL with the SHTC3, the ES8311/ES7210 and the PCF85063, and 5V pull-ups on that bus can damage all of them. Default address 0x20; leave the A0/A1/A2 pads alone. INTA/INTB do **not** need wiring — poll it |
| **Tactile switches, 6x6x5, through-hole** | Right choice over SMD for hand soldering: the legs go through the board and hold the part while you solder. Only two of the four legs are needed (they are internally paired diagonally) |
| **Double-sided perfboard 5x7cm** | Enough for eight switches with room for a d-pad layout |
| **Female-female dupont, 2.54mm, 20cm** | Connects module → board and board → buddy |

### Still missing

| Part | Search term | Why |
|---|---|---|
| **Male pin header** | `2.54mm 单排针 40P 直插` | The perfboard has bare holes. The female dupont needs something to plug **onto** — solder a strip of male pins to the board's edge |
| **Switch caps** (optional) | `6x6 轻触开关帽 圆形` | The bare 1.5mm stem is unpleasant to press repeatedly. Different colours make A/B/Start/Select tell themselves apart |
| **Hook-up wire** | `单芯镀锡铜线 0.5mm 飞线` | For the point-to-point runs on the perfboard. Cut-up dupont wire also works |

### Tools, from nothing

| Tool | Search term | Note |
|---|---|---|
| Soldering iron | `恒温电烙铁 T12 套装` | Temperature-controlled. A fixed-power iron is the usual reason a first attempt goes badly — too cold and the joint is grey and loose, too hot and the pad lifts. ~300-320°C for this work |
| Solder | `含松香焊锡丝 0.8mm 有铅` | **Leaded**, for a first project: it melts ~40°C lower and wets far more forgivingly. 0.8mm suits this scale |
| Flux | `助焊膏` or `松香` | Turns a bad joint into a good one more often than technique does |
| Stand + cleaner | `烙铁架 带清洁钢丝球` | The brass wool kind, not a wet sponge — it does not cool the tip |
| Flush cutters | `电子斜口钳` | For trimming legs after soldering |
| Tweezers | `防静电镊子 弯头` | |
| **Desoldering braid** | `吸锡带 脱焊编织线` | The beginner's most-used tool. Every bridged joint comes apart with this |
| Multimeter | `数字万用表` | Continuity mode. Checking every connection **before** powering anything is what stops a wiring mistake becoming a dead board |

**Before applying power, check three things with the meter in continuity mode:**
VCC-to-GND is *not* connected anywhere; each switch closes to GND only when
pressed; and no two adjacent expander pins are bridged.

## Order of work

Each phase is useful on its own and can stop there.

**1 — Hardware, no code.** Solder the switches to the perfboard, wire each one
between an expander I/O pin and GND, add the male header, run the meter checks.
Nothing is connected to the buddy yet.

**2 — Driver, no game.** An `mcp23017` device class alongside `pcf85063.{h,cpp}`
in `components/port_bsp`, same shape: constructor takes the existing
`I2cMasterBus`, one `read()` returning 16 bits. Enable the chip's internal
pull-ups so a switch needs no resistor. Verify with a `diag()` line per press.
Run `i2c_master_probe` across the bus first and confirm 0x20 is free.

At the end of this phase the device has **ten** buttons. That is worth having
even if the game never happens — the pokedex and capture screens are currently
squeezed onto gestures because there were only two.

**3 — Game Boy core.** `Peanut-GB` is a single-header C emulator written for
embedded targets and is the realistic starting point. Work: wire its frame
callback to the 2x2 shade mapping above, its input callback to the expander, and
run the ROM from the TF card so a 16MB flash is not spent on it.

Target 30 fps. Measure the emulation step **before** wiring the display, so that
if the CPU turns out to be the limit it is found on its own rather than mixed
into a frame-time number.

**4 — Living with the buddy.** A game mode that suspends the buddy panel: the
tick keeps running (bond, encounters, the save all matter whether or not anyone
is looking — the pokedex screen already works this way, see `runOneTick`'s
`shouldPush`), pushes are suppressed, and the animator is paused exactly once.

**Exit is BOOT double**, per the owner. This **conflicts** with the firmware
today, where BOOT double is `enter_local_clock_mode` and stops the WiFi radio
before the host hears anything. Inside game mode it has to mean "leave the
game", which spends power-save's only entry gesture for the duration. That is
acceptable — power-save is reachable again the moment you are back on the buddy
panel — but it must be a deliberate mode-scoped change, not a global one, and
the existing test that pins "BOOT double still passes through" needs a
game-mode case beside it rather than a rewrite.

## Risks, honestly

- **The CPU budget is the one number still unmeasured.** DMG emulation on
  ESP32-class hardware is well established and an S3 has more headroom than the
  parts it is usually done on, but that is a judgement, not a measurement here.
  Phase 3 measures it before anything depends on it.
- **Audio is not planned.** The DMG APU is four channels; the codec can play
  them, but nothing about it has been thought through and it is not needed for
  a playable first version.
- **The ROM is the owner's to supply.**
- **Nothing about the buddy changes until phase 4.** Phases 1-3 add hardware and
  a mode; the panel, the save, the transport and the wake path are untouched.
