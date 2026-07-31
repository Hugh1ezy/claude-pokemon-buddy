import { test } from "node:test";
import assert from "node:assert/strict";

import { isFrozenSpecies, rosterEntries, swapActiveBuddy } from "../src/pet/roster.js";
import { evolutionDescendants } from "../src/pet/species-meta.js";
import { expToNextLevel } from "../src/pet/sim.js";

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
  // Not 20 any more: on the way out it cashed today's four halves into exp
  // (owner's ask, 2026-07-31). The round trip still returns the SAME pokemon,
  // which is what this test guards -- it just comes back slightly further along.
  assert.equal(round.exp, 20 + (expToNextLevel(18) / 200) * 4);
  assert.equal(round.bond, 21);
  // NOT bondHalves. This asserted 4 until 2026-07-31, when the owner ruled that
  // today's hearts belong to whoever is on the panel earning them rather than
  // riding along with the pokemon. Lifetime `bond` above is the one that
  // travels; see the two tests at the end of this file.
  assert.equal(round.bondHalves, 0);
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

// Owner, 2026-07-31: he swapped to a pokemon caught minutes earlier and it came
// up already showing a heart and a half. Those halves were the day's, earned by
// the buddy that just left.
test("a swapped-in pokemon starts today's hearts at zero", () => {
  const before = pet({
    bondHalves: 3,
    bondSlots: 0b111,
    dexCaught: ["ivysaur", "pidgey"],
    box: [{ species: "pidgey", level: 7, bond: 3 }],
  });
  const after = swapActiveBuddy(before, "pidgey");

  assert.equal(after.bondHalves, 0, "the new buddy has earned nothing today");
  // The slot mask is the DAY's, not the pokemon's. Resetting it too would let a
  // swap re-collect hours already paid, so a few swaps would pay the day twice.
  assert.equal(after.bondSlots, 0b111, "hours already paid stay paid");
});

test("swapping does not hand the day's hearts back to the one that earned them", () => {
  const before = pet({
    bondHalves: 3,
    dexCaught: ["ivysaur", "pidgey"],
    box: [{ species: "pidgey", level: 7, bond: 3 }],
  });
  const round = swapActiveBuddy(swapActiveBuddy(before, "pidgey"), "ivysaur");

  assert.equal(round.species, "ivysaur");
  assert.equal(round.bondHalves, 0, "the halves are spent, not stored on the pokemon");
  assert.equal(round.bond, 21, "lifetime bond still travels with the pokemon");
});

// Owner's ask, 2026-07-31. Knowingly a second payment -- applyBondTick already
// granted the exp when it credited each half -- so the test pins the RATE and
// the bound rather than pretending it is a correction.
test("the departing pokemon cashes today's hearts into exp", () => {
  const before = pet({
    level: 10, exp: 0, bondHalves: 4,
    dexCaught: ["ivysaur", "pidgey"],
    box: [{ species: "pidgey", level: 7, bond: 3 }],
  });
  const after = swapActiveBuddy(before, "pidgey");
  const stored = after.box.find((entry) => entry.species === "ivysaur");

  // Half a percent of the level in progress per half heart, four of them.
  assert.equal(stored.exp, (expToNextLevel(10) / 200) * 4);
});

test("a swap with no hearts earned today pays nothing", () => {
  const before = pet({
    level: 10, exp: 5, bondHalves: 0,
    dexCaught: ["ivysaur", "pidgey"],
    box: [{ species: "pidgey", level: 7, bond: 3 }],
  });
  const after = swapActiveBuddy(before, "pidgey");
  const stored = after.box.find((entry) => entry.species === "ivysaur");

  assert.equal(stored.exp, 5, "nothing accrued, nothing to cash");
});

// The bound that keeps this from being farmable: a half heart can only be
// cashed once, because the swap that cashes it also zeroes the counter.
test("swapping twice in a row cannot cash the same hearts again", () => {
  const before = pet({
    level: 10, exp: 0, bondHalves: 4,
    dexCaught: ["ivysaur", "pidgey"],
    box: [{ species: "pidgey", level: 7, bond: 3 }],
  });
  const once = swapActiveBuddy(before, "pidgey");
  const back = swapActiveBuddy(once, "ivysaur");

  assert.equal(back.exp, (expToNextLevel(10) / 200) * 4, "still just the one payment");
  const storedPidgey = back.box.find((entry) => entry.species === "pidgey");
  assert.equal(storedPidgey.exp ?? 0, 0, "pidgey earned nothing while on the panel");
});
