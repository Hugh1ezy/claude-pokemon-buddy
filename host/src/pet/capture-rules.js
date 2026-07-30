// What a throw MEANS: the two attacks, the capture, the HP bar, and how an
// encounter ends. Pure, species-free, and separate from the slider maths so the
// rules can be read as rules.
//
// The owner's design, 2026-07-30, after the first single-throw version proved
// unplayable against button latency:
//
//   throw 1  attack     throw 2  attack     throw 3+  capture
//
// The two attacks exist to be PRACTICE. A is fixed for the whole encounter, so
// by the third throw you have seen the same target twice and know how early to
// press. Difficulty stops being "can you guess the lag" and becomes "don't
// panic on the last one".
import { ZONE } from "./capture.js";

// Twelve, and the size is forced rather than chosen. The rules need
//   HP_MAX - (a B hit) - (a C hit) > 1
// or B+C would leave exactly 1 and a C-capture after it would succeed -- which
// contradicts the owner's B+C+C = "retry". That needs HP_MAX > 6, and the
// halves and thirds need it divisible by 6. Twelve is the smallest that is both.
export const HP_MAX = 12;

export const OUTCOME = { CAUGHT: "caught", FLED: "fled", RETRY: "retry" };
export const STEP = { ATTACK: "attack", CAPTURE: "capture" };

// Attacks never take the last point. That single clamp is what makes "the
// second B does half-minus-one" fall out on its own rather than being a special
// case: two B hits land on exactly 1, which is the state a C-capture needs.
const DAMAGE = { [ZONE.B]: HP_MAX / 2, [ZONE.C]: HP_MAX / 3, [ZONE.NONE]: 0 };

export function createEncounter({ teleports = false } = {}) {
  return { hp: HP_MAX, thrown: 0, teleports, log: [] };
}

// A teleporter gets one throw and it is the capture -- it is gone before you
// could hit it twice. The owner's note: in the games this is 凯西's whole
// character, and it is the only one that does it.
export function stepKind(state) {
  if (state.teleports) return STEP.CAPTURE;
  return state.thrown < 2 ? STEP.ATTACK : STEP.CAPTURE;
}

export function applyThrow(state, zone) {
  const kind = stepKind(state);
  const next = { ...state, thrown: state.thrown + 1, log: [...state.log, zone] };

  if (kind === STEP.ATTACK) {
    return {
      state: { ...next, hp: Math.max(1, state.hp - DAMAGE[zone]) },
      outcome: null,
    };
  }

  // Capture.
  if (state.teleports) {
    // Anything but a clean hit and it is gone. No retry: one throw is the whole
    // encounter for a teleporter.
    return { state: next, outcome: zone === ZONE.B ? OUTCOME.CAUGHT : OUTCOME.FLED };
  }

  switch (zone) {
    // A clean hit always lands it, however badly the attacks went.
    case ZONE.B:
      return { state: next, outcome: OUTCOME.CAUGHT };
    // The forgiving band only closes the deal on a pokemon already worn to its
    // last point -- which is reachable only by landing BOTH attacks in B.
    case ZONE.C:
      return { state: next, outcome: next.hp === 1 ? OUTCOME.CAUGHT : OUTCOME.RETRY };
    // Missing the whole piece on the throw that matters ends it, no matter how
    // well the attacks went.
    default:
      return { state: next, outcome: OUTCOME.FLED };
  }
}

// For the panel: how full the bar is, 0..1.
export function hpFraction(state) {
  return Math.max(0, Math.min(1, state.hp / HP_MAX));
}
