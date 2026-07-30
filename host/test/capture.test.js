import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ZONE,
  createEncounterThrow,
  judgeZone,
  sliderBands,
  sliderCentre,
} from "../src/pet/capture.js";

// Invented parameters on no species at all, the same convention the encounter
// tests use: these pin the slider without recording anything about which of the
// 151 is hard.
const PARAMS = { bHalf: 0.05, cHalf: 0.15, speed: 0.001 };
const at = (target, params = PARAMS) => ({ target, phase: 0, params });

test("a throw lands in B at the centre, C around it, and nothing further out", () => {
  const centre = sliderCentre(at(0), 0);

  assert.equal(judgeZone(at(centre), 0), ZONE.B);
  assert.equal(judgeZone(at(centre + 0.04), 0), ZONE.B);
  assert.equal(judgeZone(at(centre + 0.10), 0), ZONE.C);
  assert.equal(judgeZone(at(centre + 0.149), 0), ZONE.C);
  assert.equal(judgeZone(at(centre + 0.20), 0), ZONE.NONE);
});

test("the bands are symmetric, so a miss to either side judges the same", () => {
  const centre = sliderCentre(at(0), 0);
  for (const offset of [0.03, 0.10, 0.30]) {
    assert.equal(judgeZone(at(centre - offset), 0), judgeZone(at(centre + offset), 0), `offset ${offset}`);
  }
});

// C is the forgiving band. If B ever reached the edge of C there would be no
// band left to land in, and the whole retry rule would have nothing to act on.
test("C is always strictly wider than B", () => {
  const bands = sliderBands(at(0.5), 1234);
  assert.ok(bands.c[0] < bands.b[0], "C must extend left of B");
  assert.ok(bands.c[1] > bands.b[1], "C must extend right of B");
});

test("the slider turns around at the walls instead of wrapping", () => {
  const state = at(0.5);
  const samples = [];
  for (let t = 0; t <= 4000; t += 25) samples.push(sliderCentre(state, t));

  assert.ok(Math.min(...samples) >= PARAMS.cHalf - 1e-9);
  assert.ok(Math.max(...samples) <= 1 - PARAMS.cHalf + 1e-9);

  // A wrap shows up as a single huge jump between consecutive samples; a
  // turnaround does not.
  let biggest = 0;
  for (let i = 1; i < samples.length; i += 1) {
    biggest = Math.max(biggest, Math.abs(samples[i] - samples[i - 1]));
  }
  assert.ok(biggest < 0.1, `no sample-to-sample teleport, biggest was ${biggest.toFixed(3)}`);
});

// C hanging off the end would quietly be a smaller C, i.e. a harder species
// than the tuning asked for, but only at the edges of the bar.
test("C never runs off either end of the bar", () => {
  const state = at(0.5);
  for (let t = 0; t <= 5000; t += 17) {
    const bands = sliderBands(state, t);
    assert.ok(bands.c[0] >= 0 && bands.c[1] <= 1, `t=${t} put C at ${bands.c}`);
    assert.ok(
      bands.c[1] - bands.c[0] > PARAMS.cHalf * 1.99,
      `t=${t} squashed C to ${(bands.c[1] - bands.c[0]).toFixed(4)}`,
    );
  }
});

// The heart of the 07-30 redesign. The two attacks are practice, and practice
// against a target that moved between attempts teaches nothing -- which is
// exactly what the first, single-throw version did by re-rolling A each time.
test("A is drawn once per encounter and never redrawn", () => {
  let calls = 0;
  const rng = () => { calls += 1; return (calls * 0.137) % 1; };

  const state = createEncounterThrow({ params: PARAMS, rng });
  assert.equal(calls, 2, "exactly two draws: the target and the slider phase");

  // Judging the same encounter over and over must not consult the rng again.
  for (const t of [0, 250, 900, 4000]) judgeZone(state, t);
  assert.equal(calls, 2, "judging a throw must not redraw anything");
});

test("two encounters get different targets", () => {
  const rng = (() => { const xs = [0.2, 0.9, 0.7, 0.1]; let i = 0; return () => xs[i++ % xs.length]; })();
  assert.notEqual(
    createEncounterThrow({ params: PARAMS, rng }).target,
    createEncounterThrow({ params: PARAMS, rng }).target,
  );
});

test("a degenerate tuning parks the slider rather than dividing by zero", () => {
  const state = at(0.5, { bHalf: 0.5, cHalf: 0.5, speed: 0.001 });
  for (const t of [0, 100, 9999]) {
    assert.equal(Number.isFinite(sliderCentre(state, t)), true, `t=${t} produced a non-finite centre`);
    assert.equal(sliderCentre(state, t), 0.5);
  }
});
