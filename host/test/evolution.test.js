import { test } from "node:test";
import assert from "node:assert/strict";
import { eligibleBranches, resolveEvolution } from "../src/pet/evolution.js";

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

test("stone branch overrides when another branch is also eligible", () => {
  const resolved = resolveEvolution("eevee", {
    bond: 170,
    daytime: true,
    stone: "fire",
  });

  assert.equal(resolved.auto, "flareon");
  assert.deepEqual(
    resolved.candidates.map(({ to, priority }) => ({ to, priority })),
    [
      { to: "espeon", priority: 2 },
      { to: "flareon", priority: 9 },
    ],
  );
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
