import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseAuto, eligibleBranches, resolveEvolution } from "../src/pet/evolution.js";

test("care-gated Eevee branch auto-resolves before lower-priority branches", () => {
  const cands = eligibleBranches("eevee", {
    bond: 56,
    care: true,
    daytime: true,
    warmHumid: true,
  });
  const resolved = resolveEvolution("eevee", {
    bond: 56,
    care: true,
    daytime: true,
    warmHumid: true,
  });

  assert.deepEqual(
    cands.map(({ to, priority }) => ({ to, priority })),
    [
      { to: "sylveon", priority: 1 },
      { to: "espeon", priority: 2 },
      { to: "leafeon", priority: 3 },
    ],
  );
  assert.equal(resolved.auto, "sylveon");
  assert.deepEqual(resolved.candidates, cands);
});

test("daytime Eevee without care or environment auto-resolves to Espeon", () => {
  const resolved = resolveEvolution("eevee", { bond: 56, daytime: true });

  assert.deepEqual(resolved, {
    auto: "espeon",
    candidates: [
      {
        to: "espeon",
        needs: { bond: 56, daytime: true },
        priority: 2,
      },
    ],
  });
});

test("night Eevee without care auto-resolves to Umbreon", () => {
  const resolved = resolveEvolution("eevee", { bond: 56, night: true });

  assert.deepEqual(resolved, {
    auto: "umbreon",
    candidates: [
      {
        to: "umbreon",
        needs: { bond: 56, night: true },
        priority: 2,
      },
    ],
  });
});

test("warm humid daytime Eevee without care waits for player branch choice", () => {
  const resolved = resolveEvolution("eevee", { bond: 56, daytime: true, warmHumid: true });

  assert.equal(resolved.auto, null);
  assert.deepEqual(
    resolved.candidates.map(({ to, priority }) => ({ to, priority })),
    [
      { to: "espeon", priority: 2 },
      { to: "leafeon", priority: 3 },
    ],
  );
});

// The rule KEY acts on, exercised against branches invented here rather than
// against the real tables. Several of those are spoilers, and a test that had to
// name a real condition to reach this code would put one in a file the owner
// reads.
test("one destination reached by several roads still evolves on KEY", () => {
  const auto = chooseAuto([
    { to: "portmanteau", needs: { level: 30, bond: 40 }, priority: 1 },
    { to: "portmanteau", needs: { level: 26, bond: 30, warmHumid: true }, priority: 3 },
  ]);

  // Two roads, one place: nothing to choose between, so it must not stall on a
  // prompt offering the same name twice.
  assert.equal(auto, "portmanteau");
});

test("two destinations hand the choice back to the owner", () => {
  const auto = chooseAuto([
    { to: "portmanteau", needs: { bond: 40 }, priority: 2 },
    { to: "spoonerism", needs: { bond: 40 }, priority: 3 },
  ]);

  assert.equal(auto, null);
});

test("a priority-1 care branch outranks everything, however many roads there are", () => {
  const auto = chooseAuto([
    { to: "portmanteau", needs: { bond: 40, care: true }, priority: 1 },
    { to: "spoonerism", needs: { bond: 40 }, priority: 2 },
  ]);

  assert.equal(auto, "portmanteau");
});

test("no eligible branch is not an evolution", () => {
  assert.equal(chooseAuto([]), null);
});

test("bulbasaur evolves to ivysaur at level 16, ivysaur to venusaur at 32 (official gates)", () => {
  assert.equal(resolveEvolution("bulbasaur", { level: 15 }).auto, null);
  assert.equal(resolveEvolution("bulbasaur", { level: 16 }).auto, "ivysaur");
  assert.equal(resolveEvolution("ivysaur", { level: 31 }).auto, null);
  assert.equal(resolveEvolution("ivysaur", { level: 32 }).auto, "venusaur");
});

test("charmander -> charmeleon at 16, charmeleon -> charizard at 36", () => {
  assert.equal(resolveEvolution("charmander", { level: 15 }).auto, null);
  assert.equal(resolveEvolution("charmander", { level: 16 }).auto, "charmeleon");
  assert.equal(resolveEvolution("charmeleon", { level: 35 }).auto, null);
  assert.equal(resolveEvolution("charmeleon", { level: 36 }).auto, "charizard");
});

test("squirtle line loads (data-driven, no code per species)", () => {
  assert.equal(resolveEvolution("squirtle", { level: 16 }).auto, "wartortle");
  assert.equal(resolveEvolution("wartortle", { level: 36 }).auto, "blastoise");
});

test("eevee branches still resolve by bond (regression)", () => {
  assert.equal(resolveEvolution("eevee", { bond: 56, daytime: true }).auto, "espeon");
});
