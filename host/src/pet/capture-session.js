// Drives one encounter's worth of capture: two attacks, then the capture, then
// however many retries it takes. Every side effect is injected -- clock, sleep,
// push, render -- so the whole thing runs in a test at a thousand times speed
// with no device.
//
// It owns no state that outlives the encounter and never writes the save. The
// result comes back as a value for the caller to hand to the tick, which is the
// only thing that owns the pet (same shape as the evolution intents).
//
// **No time limit.** The owner's call, 2026-07-30: `offerMs` governs how long
// the NOTIFICATION stands, not how long you get to aim once you are in here.
// The only ways out are an outcome or BOOT short.
import { createEncounterThrow, judgeZone } from "./capture.js";
import { OUTCOME, STEP, applyThrow, createEncounter, stepKind } from "./capture-rules.js";
import { MUSIC } from "./music-audio.js";

// 20fps. Affordable rather than arbitrary: one slider step measured 304 bytes
// of dirty rect (out/capture-probe.mjs), against 2850 for a single buddy-bob
// frame the animator already pushes three times a second. Rendering is 6ms, so
// the interval is what sets the rate, not the work.
export const FRAME_MS = 50;

export async function runCaptureSession({
  species,
  zh,
  params,
  render,
  push,
  now,
  sleep,
  rng = Math.random,
  pressed,        // () => boolean, cleared by takePress
  takePress,      // () => void
  aborted = () => false,   // BOOT short: back out to the buddy panel
  phases,         // { THROW, WOBBLE, CAUGHT, RETRY, ESCAPED, HIT } durations
  PHASE,
  // Injected like every other side effect here, and defaulted to a no-op so the
  // existing tests keep driving this with no device and no sound at all.
  playSound = () => {},
  logger = null,
} = {}) {
  // Drawn ONCE. A does not move between the attacks or across a retry -- the
  // two attacks are the practice that makes the capture hittable, and a target
  // that moved would make them worthless.
  const slider = createEncounterThrow({ params, rng });
  let rules = createEncounter({ teleports: Boolean(params?.teleports) });
  // Function-scoped so play() below can see it -- it is what tells a frame
  // whether this throw is an attack or the capture.
  let kind = null;

  // **No background music.** Owner's call, 2026-08-04: the capture screen used to
  // open a looping BGM here and stop it on every exit. It plays nothing now, and
  // the catch jingle below is the only sound this screen makes on its own.
  //
  // What the removal is NOT allowed to cost: silence on the throw button. KEY
  // short is the throw, and the firmware answers KEY with the buddy's own cry
  // unless something tells it the host owns the screen. That used to be
  // `g_bgm_active`, set as a side effect of the loop being queued -- so deleting
  // the music would have handed every throw a cry, which is the noise the pokedex
  // had removed the night before. The caller holds `g_host_screen` up for the
  // whole session instead (`syncScreenHold()` in index.js), which is the flag
  // that actually means what is wanted here.
  //
  // `MUSIC.CAPTURE_BGM` and `CAPTURE_BGM_STOP` deliberately stay in the sound
  // table: an id is `soundBase + index`, so dropping them from seed/music.json
  // would repoint every id after them against an already-flashed image.
  for (;;) {
    kind = stepKind(rules);
    const aimStart = now();
    takePress();                       // discard the press that opened the screen

    let zone = null;
    while (zone == null) {
      if (aborted()) return { outcome: "aborted" };
      if (pressed()) {
        takePress();
        const frozenAt = now() - aimStart;
        zone = judgeZone(slider, frozenAt);
        slider.frozenAt = frozenAt;
        break;
      }
      await push(await render({
        species, zh, phase: PHASE.AIM, elapsed: now() - aimStart,
        state: slider, rules, kind,
      }));
      await sleep(FRAME_MS);
    }

    const before = rules;
    const applied = applyThrow(rules, zone);
    rules = applied.state;
    logger?.log?.(`capture: ${kind} landed ${zone}${applied.outcome ? ` -> ${applied.outcome}` : ""}`);

    // The throw flies whatever it was for -- the ball on a capture, a strike on
    // an attack. Both need the same beat before the result lands.
    await play(PHASE.THROW, phases[PHASE.THROW]);

    if (kind === STEP.ATTACK) {
      // The bar drops during this, so it has to be its own phase rather than a
      // side effect of the next aim frame: watching it fall is the feedback
      // that says the attack connected.
      await play(PHASE.HIT, phases[PHASE.HIT], { before });
      continue;
    }

    if (applied.outcome === OUTCOME.FLED) {
      await play(PHASE.ESCAPED, phases[PHASE.ESCAPED]);
      return { outcome: "escaped" };
    }

    // Both remaining outcomes rock the ball first. Showing the wobble only on a
    // success would give the result away before it played.
    await play(PHASE.WOBBLE, phases[PHASE.WOBBLE]);

    if (applied.outcome === OUTCOME.CAUGHT) {
      // Fired before the phase rather than inside it: `play` loops for the whole
      // duration, so anything in there would retrigger every 50ms frame.
      //
      // This used to borrow the evolution fanfare, because the firmware had three
      // system sounds and none of them was a catch. It has had its own since
      // 07-31, written in the same key as the BGM it used to interrupt -- that
      // relationship is now only history, since there is nothing to interrupt.
      // It is the one sound left on this screen.
      playSound(MUSIC.CAPTURE_CAUGHT);
      await play(PHASE.CAUGHT, phases[PHASE.CAUGHT]);
      return { outcome: "caught" };
    }

    await play(PHASE.RETRY, phases[PHASE.RETRY]);
  }

  // `kind` has to be forwarded, not just the phase. Without it every frame that
  // is not an aiming frame lost track of whether this throw was an attack or
  // the capture, and the title fell through to "投球！" during both attacks.
  async function play(phase, ms, extra = {}) {
    const start = now();
    for (;;) {
      const elapsed = now() - start;
      await push(await render({ species, zh, phase, elapsed, state: slider, rules, kind, ...extra }));
      if (elapsed >= ms) return;
      if (aborted()) return;
      await sleep(FRAME_MS);
    }
  }
}
