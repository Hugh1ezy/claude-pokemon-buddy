// ⚠️ SPOILERS — 主人请勿阅读 / owner: do not read this file ⚠️
//
// How hard each species is to catch. Same rule as scripts/gen-encounters.mjs:
// the owner asked to be surprised, so the numbers live here and the mechanism
// (src/pet/capture.js) stays free of them and can be read freely.
//
// Decided by the owner 2026-07-30: the difficulty comes from `capture_rate` in
// seed/pokedex.json, which P1 already collected for all 151. Nothing else
// consumes that field, so if this is ever abandoned the field goes dead and
// should be deleted rather than left implying a mechanic that is not there.
//
// PokeAPI's capture_rate runs 3 (hardest) to 255 (easiest). Both the window and
// the speed scale with it, because moving only one of them is not enough: a
// narrow window on a slow slider is merely tedious, and a wide window on a fast
// one is still free. Difficulty should be "can you hit it", not "how long do
// you wait".
import { SPECIES_CAPTURE_RATE } from "./species-meta.js";

const EASIEST = 255;
const HARDEST = 3;

// These are set by TIME, not by width, and that is the whole trick. What the
// player controls is when they press; what a band is worth is therefore how
// many milliseconds the slider spends inside it (2 * half / speed). Sizing the
// bands by appearance instead produced a hardest tier where B was worth 17ms --
// shorter than the button's own latency, i.e. pure luck dressed up as skill.
//
// Milliseconds inside each band at each end of the range:
//
//            crossing   inside B   inside C
//   easiest    2500ms      500ms     1100ms
//   hardest    1333ms      107ms      293ms
//
// So even at the hardest, a mistimed press has ~300ms of C to land in -- it
// costs the throw, not the encounter, which is the "keep trying until B" rule
// the owner asked for. Beyond C it flees.
//
// UNMEASURED, and the reason these are gentle: nobody has played it yet. The
// numbers assume the button's own latency is small next to 107ms; if the
// hardest tier turns out to be luck rather than timing, lower SPEED.hard before
// touching anything else -- widening B first would make the easy end trivial.
const B_HALF = { easy: 0.100, hard: 0.040 };
const C_HALF = { easy: 0.220, hard: 0.110 };
// Bar fractions per millisecond.
const SPEED = { easy: 0.00040, hard: 0.00075 };

export function captureParams(species, { rate = SPECIES_CAPTURE_RATE[species] } = {}) {
  // An unknown species is treated as mid-difficulty rather than throwing: a
  // missing rate must not be able to stop a capture the player is looking at.
  const clamped = Math.min(EASIEST, Math.max(HARDEST, Number.isFinite(rate) ? rate : 90));
  // 0 at the easiest, 1 at the hardest.
  const difficulty = (EASIEST - clamped) / (EASIEST - HARDEST);

  return {
    bHalf: lerp(B_HALF.easy, B_HALF.hard, difficulty),
    cHalf: lerp(C_HALF.easy, C_HALF.hard, difficulty),
    speed: lerp(SPEED.easy, SPEED.hard, difficulty),
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
