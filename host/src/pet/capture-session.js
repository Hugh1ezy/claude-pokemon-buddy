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
import { SOUND } from "../transport/proto.js";

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
      // duration, so anything in there would retrigger every 50ms frame. The
      // fanfare is the evolution one, reused the way onboarding already reuses it
      // for hatching -- the firmware has three system sounds and no dedicated
      // capture jingle, and adding one is a reflash.
      playSound(SOUND.EVOLVE);
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
