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
// Milliseconds inside each band, measured with the numbers below:
//
//                    inside B   inside C
//   easiest (255)      579ms     1263ms
//   abra (200)         453ms     1009ms
//   clefairy (150)     363ms      826ms
//   bulbasaur (45)     221ms      540ms
//   mewtwo (3)         177ms      452ms
//
// Even the hardest gives ~180ms in B and ~450ms in C. That is the whole point
// after 07-30: the owner reported the single-throw version failing on button
// LATENCY, so the windows have to be wide enough that a consistent delay can be
// learned and compensated for. It is the three-throw structure, not a narrow
// window, that makes a rare species hard now.
const B_HALF = { easy: 0.110, hard: 0.055 };
const C_HALF = { easy: 0.240, hard: 0.140 };
// Bar fractions per millisecond.
const SPEED = { easy: 0.00038, hard: 0.00062 };

// The one species that is gone before you can hit it twice -- one throw, and it
// is the capture. The owner named it himself and it is game canon rather than a
// surprise, but it lives here so capture-rules.js can stay species-free.
const TELEPORTERS = new Set(["abra"]);

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
    teleports: TELEPORTERS.has(species),
  };
}

// Left to me on 2026-07-30, so: capture_rate still drives the slider, but
// GENTLY, and the spread was pulled in when the three-throw design landed.
//
// The reasoning, since the next person will want it. Difficulty now comes from
// two places at once -- how narrow the window is, and how many throws you have
// to keep your nerve for. Those multiply rather than add: a hard species is a
// narrow window you must hit THREE times, and the last one flees on a clean
// miss. The single-throw tuning would have compounded into something no one
// could catch. So the numbers above are the earlier ones softened, and the
// three-throw structure is left to do most of the work.
//
// If a species still feels impossible, that is this file's fault and not
// capture-rules.js's -- lower SPEED.hard first.

function lerp(a, b, t) {
  return a + (b - a) * t;
}
