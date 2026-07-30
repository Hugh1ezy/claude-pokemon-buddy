// The capture minigame's mechanism: where the slider is, and what a throw at a
// given moment does. Pure and species-free, on purpose and for the same reason
// encounter.js is -- this file can be read and reviewed without learning
// anything the owner asked to be surprised by. Which species is how hard lives
// in capture-tuning.js, which is a spoiler file.
//
// The shape, in the owner's words (docs/handoff.md has the full spec):
//
//   |------------------------[ C [ B ] C ]-----------|------|
//   0                                                A      1
//
// A is a fixed vertical line at a random spot. B slides left and right; C is B
// widened symmetrically and slides with it. A press stops the slider, and where
// A falls in the stopped piece decides the throw.
export const CAUGHT = "caught";
export const RETRY = "retry";
export const ESCAPED = "escaped";

// Everything is in bar fractions (0..1), not pixels, so the logic is
// independent of how wide the screen draws the bar.
export function createThrow({ params, rng = Math.random }) {
  return {
    // A is re-rolled for every throw. With a fixed A the slider is periodic, so
    // a retry could be won by simply repeating the timing that just failed --
    // which would make C a free pass instead of a second chance.
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

export function judgeThrow(state, t) {
  const centre = sliderCentre(state, t);
  const distance = Math.abs(state.target - centre);
  if (distance <= state.params.bHalf) return CAUGHT;
  if (distance <= state.params.cHalf) return RETRY;
  return ESCAPED;
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
