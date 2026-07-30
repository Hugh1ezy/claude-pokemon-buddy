import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HP_MAX,
  OUTCOME,
  STEP,
  applyThrow,
  createEncounter,
  stepKind,
} from "../src/pet/capture-rules.js";
import { ZONE } from "../src/pet/capture.js";

// Plays a whole encounter from a list of zones and reports how it ended, so the
// owner's own shorthand (B+C+B = 1) can be written down almost verbatim.
function play(zones, { teleports = false } = {}) {
  let state = createEncounter({ teleports });
  let outcome = null;
  for (const zone of zones) {
    if (outcome != null && outcome !== OUTCOME.RETRY) break;
    ({ state, outcome } = applyThrow(state, zone));
  }
  return { outcome, hp: state.hp, thrown: state.thrown };
}

const { B, C, NONE: N } = ZONE;

test("the first two throws are attacks and the third is the capture", () => {
  let state = createEncounter();
  assert.equal(stepKind(state), STEP.ATTACK);
  ({ state } = applyThrow(state, B));
  assert.equal(stepKind(state), STEP.ATTACK);
  ({ state } = applyThrow(state, B));
  assert.equal(stepKind(state), STEP.CAPTURE);
});

// The owner's table, verbatim.
test("B+B+B and B+B+C both catch it", () => {
  assert.equal(play([B, B, B]).outcome, OUTCOME.CAUGHT);
  assert.equal(play([B, B, C]).outcome, OUTCOME.CAUGHT);
});

test("B+C+B catches, B+C+C retries", () => {
  assert.equal(play([B, C, B]).outcome, OUTCOME.CAUGHT);
  assert.equal(play([B, C, C]).outcome, OUTCOME.RETRY);
});

test("C+C+B catches, C+C+C retries", () => {
  assert.equal(play([C, C, B]).outcome, OUTCOME.CAUGHT);
  assert.equal(play([C, C, C]).outcome, OUTCOME.RETRY);
});

test("B+B+N flees -- a perfect pair does not save a missed capture", () => {
  assert.equal(play([B, B, N]).outcome, OUTCOME.FLED);
});

// The capture throw is the only one that can end it badly.
test("missing on the capture always flees, however the attacks went", () => {
  for (const attacks of [[B, B], [B, C], [C, C], [N, N], [B, N], [N, C]]) {
    assert.equal(play([...attacks, N]).outcome, OUTCOME.FLED, `${attacks.join("+")}+N`);
  }
});

test("a clean capture always catches, however the attacks went", () => {
  for (const attacks of [[B, B], [B, C], [C, C], [N, N], [B, N], [N, C]]) {
    assert.equal(play([...attacks, B]).outcome, OUTCOME.CAUGHT, `${attacks.join("+")}+B`);
  }
});

// Two B hits are the only way to the last point, which is what makes the
// forgiving band worth earning.
test("only two B attacks wear it down to 1, which is what a C capture needs", () => {
  assert.equal(play([B, B]).hp, 1);
  assert.ok(play([B, C]).hp > 1, "B+C must not reach 1, or B+C+C would wrongly catch");
  assert.ok(play([C, B]).hp > 1);
  assert.ok(play([C, C]).hp > 1);
  assert.ok(play([N, N]).hp === HP_MAX, "a missed attack does no damage");
});

test("attacks are symmetric -- the order of B and C does not matter", () => {
  assert.equal(play([B, C]).hp, play([C, B]).hp);
  assert.equal(play([B, C, C]).outcome, play([C, B, C]).outcome);
});

test("attacks can never knock it out, only down to 1", () => {
  for (const attacks of [[B, B], [B, C], [C, C], [C, B]]) {
    assert.ok(play(attacks).hp >= 1, `${attacks.join("+")} left ${play(attacks).hp}`);
  }
});

// A missed attack does not end anything; it only costs the shortcut, so the
// capture then has to be a clean B.
test("a missed attack costs the C-capture shortcut but not the encounter", () => {
  assert.equal(play([N, B, C]).outcome, OUTCOME.RETRY);
  assert.equal(play([N, B, B]).outcome, OUTCOME.CAUGHT);
});

test("a retry is retried until it lands in B, with the same encounter underneath", () => {
  let state = createEncounter();
  ({ state } = applyThrow(state, C));
  ({ state } = applyThrow(state, C));

  let outcome;
  ({ state, outcome } = applyThrow(state, C));
  assert.equal(outcome, OUTCOME.RETRY);
  ({ state, outcome } = applyThrow(state, C));
  assert.equal(outcome, OUTCOME.RETRY, "retries do not accumulate into a success");
  ({ state, outcome } = applyThrow(state, N));
  assert.equal(outcome, OUTCOME.FLED, "but a miss during the retries still loses it");
});

// The teleporter: one throw, and it is the capture.
test("a teleporter gets a single capture throw and no attacks", () => {
  const state = createEncounter({ teleports: true });
  assert.equal(stepKind(state), STEP.CAPTURE);
  assert.equal(play([B], { teleports: true }).outcome, OUTCOME.CAUGHT);
});

test("a teleporter that is not hit cleanly is gone -- C does not retry", () => {
  assert.equal(play([C], { teleports: true }).outcome, OUTCOME.FLED);
  assert.equal(play([N], { teleports: true }).outcome, OUTCOME.FLED);
});
