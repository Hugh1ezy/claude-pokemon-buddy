// The slider: where it is at a given moment, and which band a throw at that
// moment lands in. Pure and species-free, on purpose and for the same reason
// encounter.js is -- this file can be read and reviewed without learning
// anything the owner asked to be surprised by. Which species is how hard, and
// which one teleports, lives in capture-tuning.js, a spoiler file.
//
//   |------------------------[ C [ B ] C ]-----------|------|
//   0                                                A      1
//
// A is a fixed vertical line. B slides left and right; C is B widened
// symmetrically and slides with it. A press stops the slider, and where A falls
// in the stopped piece is the ZONE. What a zone MEANS is capture-rules.js's
// business, not this file's.
export const ZONE = { B: "B", C: "C", NONE: "N" };

// A is drawn ONCE PER ENCOUNTER and does not move again -- not between the two
// attacks, not on a retry. That is the whole point of the three-throw design:
// the first two throws are where you learn the button's latency, and a target
// that moved between them would make that learning worthless.
export function createEncounterThrow({ params, rng = Math.random }) {
  return {
    target: rng(),
    phase: rng(),          // where in its sweep the slider starts
    params,
  };
}

// Triangle wave over the sweepable span, so the piece turns around at the walls
// instead of teleporting. `t` is elapsed time in ms.
export function sliderCentre(state, t) {
  const { speed, cHalf } = state.params;
  // The slider's centre stays cHalf away from both ends, so C never hangs off
  // the bar -- a C that ran off the edge would silently become a smaller C.
  const lo = cHalf;
  const hi = 1 - cHalf;
  const span = Math.max(0, hi - lo);
  if (span === 0) return lo;

  const cycle = (2 * span) / speed;            // ms for one there-and-back
  const u = (((t / cycle) + state.phase) % 1 + 1) % 1;
  const tri = u < 0.5 ? u * 2 : 2 - u * 2;     // 0..1..0
  return lo + tri * span;
}

export function judgeZone(state, t) {
  const distance = Math.abs(state.target - sliderCentre(state, t));
  if (distance <= state.params.bHalf) return ZONE.B;
  if (distance <= state.params.cHalf) return ZONE.C;
  return ZONE.NONE;
}

// The bands as fractions, for the renderer. Clamped to the bar because a
// species tuned to an extreme should draw a truncated band rather than
// scribbling outside the frame.
export function sliderBands(state, t) {
  const centre = sliderCentre(state, t);
  const { bHalf, cHalf } = state.params;
  return {
    centre,
    target: state.target,
    b: [clamp01(centre - bHalf), clamp01(centre + bHalf)],
    c: [clamp01(centre - cHalf), clamp01(centre + cHalf)],
  };
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
