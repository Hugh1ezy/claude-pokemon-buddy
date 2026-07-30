import { test } from "node:test";
import assert from "node:assert/strict";

import { isFrozenSpecies, rosterEntries, swapActiveBuddy } from "../src/pet/roster.js";
import { evolutionDescendants } from "../src/pet/species-meta.js";

const pet = (over = {}) => ({
  species: "ivysaur", level: 18, exp: 20, bond: 21, bondHalves: 4, hatched: true,
  iv: [1, 2, 3, 4, 5, 6], nature: "慢性子",
  dexCaught: ["bulbasaur", "ivysaur"], capturedCount: 0, box: [],
  ...over,
});

test("a line's forward forms are found at any depth", () => {
  assert.deepEqual(evolutionDescendants("bulbasaur").sort(), ["ivysaur", "venusaur"]);
  assert.deepEqual(evolutionDescendants("venusaur"), []);
  assert.ok(evolutionDescendants("eevee").includes("vaporeon"));
});

// The rule the owner asked for: a form you have evolved PAST is a keepsake.
test("a form you have evolved past is frozen, and the one you are on is not", () => {
  const dex = { dexCaught: ["bulbasaur", "ivysaur"], capturedCount: 0, box: [] };

  assert.equal(isFrozenSpecies("bulbasaur", dex), true, "you own its evolution, so it is a keepsake");
  assert.equal(isFrozenSpecies("ivysaur", dex), false, "this is as far as the line has got");
});

// "Does it evolve" is the wrong test and would freeze a perfectly live pet.
test("an unevolved species you have never evolved is alive", () => {
  const dex = { dexCaught: ["charmander"], capturedCount: 1, box: [] };
  assert.equal(isFrozenSpecies("charmander", dex), false);
});

test("owning a distant descendant freezes the base form too", () => {
  const dex = { dexCaught: ["bulbasaur", "venusaur"], capturedCount: 1, box: [] };
  assert.equal(isFrozenSpecies("bulbasaur", dex), true, "skipping the middle form still counts");
  assert.equal(isFrozenSpecies("venusaur", dex), false);
});

test("the roster lists everything owned including the buddy on the panel", () => {
  const entries = rosterEntries(pet());
  assert.deepEqual(entries.map((e) => e.species), ["bulbasaur", "ivysaur"]);
  assert.equal(entries.find((e) => e.species === "ivysaur").active, true);
});

// A frozen entry reports nothing rather than the level it stopped at: a number
// there reads as "this is its level" instead of "this one does not level".
test("a frozen entry reports no level and no bond at all", () => {
  const entries = rosterEntries(pet({ box: [{ species: "bulbasaur", level: 15, bond: 9 }] }));
  const seed = entries.find((e) => e.species === "bulbasaur");

  assert.equal(seed.frozen, true);
  assert.equal(seed.level, null);
  assert.equal(seed.bond, null);
});

test("a live entry keeps its own level and bond, which are not the buddy's", () => {
  const state = pet({
    species: "ivysaur",
    dexCaught: ["ivysaur", "pidgey"],
    box: [{ species: "pidgey", level: 7, bond: 3, caughtAt: "2026-07-30" }],
  });
  const pidgey = rosterEntries(state).find((e) => e.species === "pidgey");

  assert.equal(pidgey.frozen, false);
  assert.equal(pidgey.level, 7);
  assert.equal(pidgey.bond, 3);
  assert.equal(pidgey.caughtAt, "2026-07-30");
});

test("swapping puts the chosen one on the panel and the buddy in the box", () => {
  const before = pet({
    dexCaught: ["ivysaur", "pidgey"],
    box: [{ species: "pidgey", level: 7, exp: 2, bond: 3, caughtAt: "2026-07-30" }],
  });
  const after = swapActiveBuddy(before, "pidgey");

  assert.equal(after.species, "pidgey");
  assert.equal(after.level, 7);
  assert.equal(after.bond, 3);

  const stored = after.box.find((entry) => entry.species === "ivysaur");
  assert.ok(stored, "the outgoing buddy must be kept");
  assert.equal(stored.level, 18);
  assert.equal(stored.bond, 21);
  assert.deepEqual(stored.iv, [1, 2, 3, 4, 5, 6], "its personality travels with it");
  assert.ok(!after.box.some((entry) => entry.species === "pidgey"), "the incoming one leaves the box");
});

// Swapping back has to return to the same pokemon, not to a reset copy -- this
// is the property that makes the box a shelf rather than a shredder.
test("swapping away and back preserves the buddy exactly", () => {
  const before = pet({
    dexCaught: ["ivysaur", "pidgey"],
    box: [{ species: "pidgey", level: 7, bond: 3 }],
  });
  const round = swapActiveBuddy(swapActiveBuddy(before, "pidgey"), "ivysaur");

  assert.equal(round.species, "ivysaur");
  assert.equal(round.level, 18);
  assert.equal(round.exp, 20);
  assert.equal(round.bond, 21);
  assert.equal(round.bondHalves, 4);
  assert.equal(round.nature, "慢性子");
});

test("a swap does not disturb the trainer's own record", () => {
  const before = pet({
    streak: 5, capturedCount: 4, dexCaught: ["ivysaur", "pidgey"],
    encounter: { species: "rattata", offeredAt: 12 },
    box: [{ species: "pidgey", level: 7 }],
  });
  const after = swapActiveBuddy(before, "pidgey");

  assert.equal(after.streak, 5);
  assert.equal(after.capturedCount, 4, "a swap is not a capture");
  assert.deepEqual(after.encounter, { species: "rattata", offeredAt: 12 }, "a live offer survives a swap");
  assert.deepEqual(
    [...after.dexCaught].sort(),
    ["ivysaur", "pidgey"],
    "the collection is unchanged -- both were already owned",
  );
});

test("swapping to something you do not own, or to yourself, changes nothing", () => {
  const before = pet();
  assert.equal(swapActiveBuddy(before, "mewtwo"), before);
  assert.equal(swapActiveBuddy(before, "ivysaur"), before);
  assert.equal(swapActiveBuddy(before, "missingno"), before);
});

// The starter line gets its dex entries from recordSeen, which never made a box
// copy -- so the record for a keepsake can be missing entirely.
test("swapping to a species with no box entry still works", () => {
  const after = swapActiveBuddy(pet(), "bulbasaur");

  assert.equal(after.species, "bulbasaur");
  assert.equal(Number.isFinite(after.level), true, "a missing record must not produce level undefined");
  assert.equal(after.bond, 0);
});
