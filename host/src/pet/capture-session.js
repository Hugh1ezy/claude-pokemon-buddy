// Drives one encounter's worth of capture: the aiming loop, the throw, and the
// outcome. Every side effect is injected -- clock, sleep, push, render -- so the
// whole thing can be run in a test at a thousand times speed with no device.
//
// It owns no state that outlives the encounter and never writes the save. The
// result comes back as a value for the caller to hand to the tick, which is the
// only thing that owns the pet (same shape as the evolution intents).
import { CAUGHT, ESCAPED, RETRY, createThrow, judgeThrow } from "./capture.js";

// 20fps. Affordable rather than arbitrary: one slider step measured 304 bytes
// of dirty rect (out/capture-probe.mjs), against 2850 for a single buddy-bob
// frame the animator already pushes three times a second. Rendering is 6ms, so
// the interval is what sets the rate, not the work.
export const FRAME_MS = 50;

export const OUTCOME = { CAUGHT, ESCAPED, RETRY };

export async function runCaptureSession({
  species,
  zh,
  params,
  offerMsLeft,
  render,
  push,
  now,
  sleep,
  rng = Math.random,
  pressed,        // () => boolean, cleared by takePress
  takePress,      // () => void
  aborted = () => false,   // BOOT short: back out to the buddy panel
  phases,         // { THROW, WOBBLE, CAUGHT, RETRY, ESCAPED } durations
  PHASE,
  logger = null,
} = {}) {
  const deadline = now() + offerMsLeft;
  let state = createThrow({ params, rng });

  // Each pass is one throw. A RETRY re-enters the loop with a fresh A, which is
  // what stops a failed timing from being replayable.
  for (;;) {
    const aimStart = now();
    takePress();                       // discard the press that opened the screen

    let verdict = null;
    while (verdict == null) {
      // Backing out is navigation, not an outcome: the offer is left standing,
      // so walking away from the screen and coming back within offerMs finds
      // the same pokemon still there. Nothing was thrown, so nothing fled.
      if (aborted()) return { outcome: "aborted" };
      if (now() >= deadline) {
        // The offer ran out while aiming. This is an escape, not a bug: the
        // five minutes are the encounter's, not the screen's.
        await playPhase({ phase: PHASE.ESCAPED, ms: phases[PHASE.ESCAPED], species, zh, state, render, push, now, sleep });
        return { outcome: ESCAPED, reason: "expired" };
      }
      if (pressed()) {
        takePress();
        const frozenAt = now() - aimStart;
        verdict = judgeThrow(state, frozenAt);
        state = { ...state, frozenAt };
        break;
      }
      await push(await render({ species, zh, phase: PHASE.AIM, elapsed: now() - aimStart, state }));
      await sleep(FRAME_MS);
    }

    logger?.log?.(`capture: throw judged ${verdict}`);
    await playPhase({ phase: PHASE.THROW, ms: phases[PHASE.THROW], species, zh, state, render, push, now, sleep });

    if (verdict === ESCAPED) {
      await playPhase({ phase: PHASE.ESCAPED, ms: phases[PHASE.ESCAPED], species, zh, state, render, push, now, sleep });
      return { outcome: ESCAPED, reason: "missed" };
    }

    // Both remaining outcomes rock the ball first -- that is the point of the
    // wobble, and showing it only on a success would give the result away
    // before it played.
    await playPhase({ phase: PHASE.WOBBLE, ms: phases[PHASE.WOBBLE], species, zh, state, render, push, now, sleep });

    if (verdict === CAUGHT) {
      await playPhase({ phase: PHASE.CAUGHT, ms: phases[PHASE.CAUGHT], species, zh, state, render, push, now, sleep });
      return { outcome: CAUGHT };
    }

    await playPhase({ phase: PHASE.RETRY, ms: phases[PHASE.RETRY], species, zh, state, render, push, now, sleep });
    state = createThrow({ params, rng });
  }
}

async function playPhase({ phase, ms, species, zh, state, render, push, now, sleep }) {
  const start = now();
  for (;;) {
    const elapsed = now() - start;
    await push(await render({ species, zh, phase, elapsed, state }));
    if (elapsed >= ms) return;
    await sleep(FRAME_MS);
  }
}
