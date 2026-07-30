import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAUGHT,
  ESCAPED,
  RETRY,
  createThrow,
  judgeThrow,
  sliderBands,
  sliderCentre,
} from "../src/pet/capture.js";

// Invented parameters on no species at all, the same convention the encounter
// tests use: these pin the mechanism without recording anything about which of
// the 151 is hard.
const PARAMS = { bHalf: 0.05, cHalf: 0.15, speed: 0.001 };

// A throw whose slider sits exactly where we want it: phase 0 starts the
// triangle at the left wall, and we pick t to place the centre.
function throwWith({ target, phase = 0, params = PARAMS }) {
  return { target, phase, params };
}

test("a throw lands caught inside B, retry inside C, escaped outside both", () => {
  const centre = sliderCentre(throwWith({ target: 0 }), 0);

  assert.equal(judgeThrow(throwWith({ target: centre }), 0), CAUGHT);
  assert.equal(judgeThrow(throwWith({ target: centre + 0.04 }), 0), CAUGHT);
  assert.equal(judgeThrow(throwWith({ target: centre + 0.10 }), 0), RETRY);
  assert.equal(judgeThrow(throwWith({ target: centre + 0.149 }), 0), RETRY);
  assert.equal(judgeThrow(throwWith({ target: centre + 0.20 }), 0), ESCAPED);
});

test("the bands are symmetric, so a miss to either side judges the same", () => {
  const centre = sliderCentre(throwWith({ target: 0 }), 0);
  for (const offset of [0.03, 0.10, 0.30]) {
    assert.equal(
      judgeThrow(throwWith({ target: centre - offset }), 0),
      judgeThrow(throwWith({ target: centre + offset }), 0),
      `offset ${offset}`,
    );
  }
});

// C is the second chance the owner asked for. If B ever reached the edge of C
// there would be no band left to land in, and "keep trying until B" would
// silently become "one throw and it flees".
test("C is always strictly wider than B, or there is no second chance", () => {
  const bands = sliderBands(throwWith({ target: 0.5 }), 1234);
  assert.ok(bands.c[0] < bands.b[0], "C must extend left of B");
  assert.ok(bands.c[1] > bands.b[1], "C must extend right of B");
});

test("the slider turns around at the walls instead of wrapping", () => {
  const state = throwWith({ target: 0.5 });
  const samples = [];
  for (let t = 0; t <= 4000; t += 25) samples.push(sliderCentre(state, t));

  const lo = Math.min(...samples);
  const hi = Math.max(...samples);
  assert.ok(lo >= PARAMS.cHalf - 1e-9, `never left of cHalf, got ${lo}`);
  assert.ok(hi <= 1 - PARAMS.cHalf + 1e-9, `never right of 1-cHalf, got ${hi}`);

  // A wrap shows up as a single huge jump between consecutive samples; a
  // turnaround does not.
  let biggest = 0;
  for (let i = 1; i < samples.length; i += 1) {
    biggest = Math.max(biggest, Math.abs(samples[i] - samples[i - 1]));
  }
  assert.ok(biggest < 0.1, `no sample-to-sample teleport, biggest was ${biggest.toFixed(3)}`);
});

// C hanging off the end would quietly be a smaller C, i.e. a harder species
// than the tuning asked for, only at the edges of the bar.
test("C never runs off either end of the bar", () => {
  const state = throwWith({ target: 0.5 });
  for (let t = 0; t <= 5000; t += 17) {
    const bands = sliderBands(state, t);
    assert.ok(bands.c[0] >= 0 && bands.c[1] <= 1, `t=${t} put C at ${bands.c}`);
    // And it must not be clamped to a stub either -- the full width should fit.
    assert.ok(
      bands.c[1] - bands.c[0] > PARAMS.cHalf * 1.99,
      `t=${t} squashed C to ${(bands.c[1] - bands.c[0]).toFixed(4)}`,
    );
  }
});

// With a fixed A the slider is periodic, so a failed throw could be won by
// repeating the exact timing that just failed -- C would be a free pass rather
// than a second chance.
test("every throw re-rolls where A sits", () => {
  const values = new Set();
  let calls = 0;
  const rng = () => { calls += 1; return (calls * 0.137) % 1; };
  for (let i = 0; i < 8; i += 1) values.add(createThrow({ params: PARAMS, rng }).target);

  assert.equal(values.size, 8, "eight throws produced a repeated target");
});

test("a throw carries its own starting phase, so two encounters do not run in lockstep", () => {
  const rng = (() => { const xs = [0.2, 0.9, 0.4, 0.1]; let i = 0; return () => xs[i++ % xs.length]; })();
  const a = createThrow({ params: PARAMS, rng });
  const b = createThrow({ params: PARAMS, rng });

  assert.notEqual(a.phase, b.phase);
  // Compared over time rather than at t=0: the triangle wave is symmetric, so
  // two different phases can share a position at any single instant while
  // travelling in opposite directions. Only the trajectories have to differ.
  const path = (state) => Array.from({ length: 20 }, (_, i) => sliderCentre(state, i * 60).toFixed(4)).join(",");
  assert.notEqual(path(a), path(b));
});

test("a degenerate tuning parks the slider rather than dividing by zero", () => {
  const params = { bHalf: 0.5, cHalf: 0.5, speed: 0.001 };
  const state = throwWith({ target: 0.5, params });

  for (const t of [0, 100, 9999]) {
    assert.equal(Number.isFinite(sliderCentre(state, t)), true, `t=${t} produced a non-finite centre`);
    assert.equal(sliderCentre(state, t), 0.5);
  }
});
