import assert from "node:assert/strict";
import test from "node:test";

import { encounterRevealParts, evolutionRevealParts, fitReveal } from "../src/pet/reveal.js";
import { applyPetTransitions } from "../src/pet/transitions.js";

// Every condition in this file is invented. The real tables are a surprise and
// a test that quoted one would put it in a file the owner reads.

test("a level-only evolution has nothing to explain", () => {
  assert.deepEqual(evolutionRevealParts({ level: 16 }), []);
  assert.deepEqual(evolutionRevealParts(null), []);
});

test("a conditional evolution is worded, the moment before the build-up", () => {
  assert.deepEqual(
    evolutionRevealParts({ level: 20, bond: 30, night: true, weatherKind: "rain" }),
    ["雨天", "夜晚", "亲密度≥30", "Lv≥20"],
  );
});

test("an encounter with no conditions has nothing to explain", () => {
  assert.deepEqual(encounterRevealParts(undefined), []);
  assert.deepEqual(encounterRevealParts({}), []);
  assert.deepEqual(encounterRevealParts({ notTheStarter: "anything" }), []);
});

test("encounter conditions are worded", () => {
  assert.deepEqual(
    encounterRevealParts({ dexAtLeast: 40, weekday: ["sat", "sun"], tempBelow: 12, night: false }),
    ["白天", "周末", "气温<12°", "图鉴≥40"],
  );
  assert.deepEqual(
    encounterRevealParts({ caughtAll: ["a", "b"] }, { nameOf: (key) => key.toUpperCase() }),
    ["已收服A、B"],
  );
});

test("fitReveal keeps what fits and marks what it dropped", () => {
  const measure = (text) => text.length;
  assert.equal(fitReveal([], { measure, maxWidth: 10 }), null);
  assert.equal(fitReveal(["ab", "cd"], { measure, maxWidth: 100 }), "★ ab · cd");
  assert.equal(fitReveal(["ab", "cdefghij", "k"], { measure, maxWidth: 8 }), "★ ab…");
});

test("the evolution animation is handed the needs of the road taken", () => {
  // squirtle's line is level-only and public, so it can be named here.
  const { evolutionAnimation } = applyPetTransitions({
    pet: { species: "squirtle", level: 16, bond: 0, careCount: 0 },
    now: new Date(2026, 9, 13, 12),
    buttonEvents: [{ key: "KEY", kind: "short" }],
  });
  assert.equal(evolutionAnimation?.toSpecies, "wartortle");
  assert.deepEqual(evolutionAnimation?.needs, { level: 16 });
});
