import { test } from "node:test";
import assert from "node:assert/strict";

import { applyCaptureResults } from "../src/index.js";
import { boxPet, dexProgress } from "../src/pet/dex.js";
import { expToNextLevel } from "../src/pet/sim.js";
import { SPECIES_ORDER } from "../src/pet/species-meta.js";

const A = SPECIES_ORDER[20];
const B = SPECIES_ORDER[21];
const base = () => ({
  species: "bulbasaur", level: 9, hatched: true,
  dexCaught: [], capturedCount: 0, box: [],
});

const queue = (items) => ({ drain: () => items });

test("a catch records the dex entry, the tally and the box", () => {
  const pet = applyCaptureResults({ ...base(), encounter: { species: A, offeredAt: 1 } },
    queue([{ species: A, outcome: "caught" }]), null);

  const progress = dexProgress(pet);
  assert.equal(progress.dexCaught, 1);
  assert.equal(progress.capturedCount, 1);
  assert.equal(progress.boxCount, 1);
});

// Every outcome ends the encounter. Leaving the offer up after a miss would let
// the same pokemon be thrown at again, which is precisely what "it flees" means
// it should not allow.
test("every outcome clears the offer, not just a catch", () => {
  for (const outcome of ["caught", "escaped", "retry"]) {
    const pet = applyCaptureResults({ ...base(), encounter: { species: A, offeredAt: 1 } },
      queue([{ species: A, outcome }]), null);
    assert.equal(pet.encounter, null, `outcome ${outcome} left the offer standing`);
  }
});

test("a miss records nothing at all", () => {
  const pet = applyCaptureResults({ ...base(), encounter: { species: A, offeredAt: 1 } },
    queue([{ species: A, outcome: "escaped" }]), null);

  const progress = dexProgress(pet);
  assert.equal(progress.dexCaught, 0);
  assert.equal(progress.capturedCount, 0);
  assert.equal(progress.boxCount, 0);
});

// The 捕捉 tally counts throws that landed, so a second of the same species
// moves it; 图鉴 counts distinct species, so it does not.
test("a duplicate moves the tally and not the dex", () => {
  let pet = applyCaptureResults(base(), queue([{ species: A, outcome: "caught" }]), null);
  pet = applyCaptureResults(pet, queue([{ species: A, outcome: "caught" }]), null);

  const progress = dexProgress(pet);
  assert.equal(progress.dexCaught, 1);
  assert.equal(progress.capturedCount, 2);
  assert.equal(progress.boxCount, 1, "the box keeps one per species");
});

test("an outcome for a species that is not the current offer leaves the offer alone", () => {
  const pet = applyCaptureResults({ ...base(), encounter: { species: B, offeredAt: 1 } },
    queue([{ species: A, outcome: "escaped" }]), null);

  assert.equal(pet.encounter?.species, B);
});

test("junk in the queue is skipped rather than thrown on", () => {
  const pet = applyCaptureResults({ ...base(), encounter: { species: A, offeredAt: 1 } },
    queue([null, undefined, {}, { outcome: "caught" }, { species: 42, outcome: "caught" },
      { species: "missingno", outcome: "caught" }]), null);

  assert.equal(dexProgress(pet).capturedCount, 0);
  assert.equal(pet.encounter?.species, A, "nothing valid arrived, so nothing was cleared");
});

test("an empty queue returns the pet untouched, so a quiet tick writes no change", () => {
  const pet = base();
  assert.equal(applyCaptureResults(pet, queue([]), null), pet);
  assert.equal(applyCaptureResults(pet, undefined, null), pet);
});

test("an array queue is drained, not just read", () => {
  const items = [{ species: A, outcome: "caught" }];
  const pet = applyCaptureResults(base(), items, null);

  assert.equal(dexProgress(pet).capturedCount, 1);
  assert.equal(items.length, 0, "a result applied twice would double-count the tally");
});

// The arm-encounter fixture marks its offers. Without this every dry run
// inflated 捕捉 and lit a dex entry that was never actually earned -- which is
// exactly what happened on 2026-07-30, five times.
test("a test encounter plays out and records nothing", () => {
  const pet = applyCaptureResults({ ...base(), encounter: { species: A, offeredAt: 1 } },
    queue([{ species: A, outcome: "caught", test: true }]), null);

  const progress = dexProgress(pet);
  assert.equal(progress.capturedCount, 0, "捕捉 must not move for a fixture");
  assert.equal(progress.dexCaught, 0, "nor may the dex light up");
  assert.equal(progress.boxCount, 0);
  assert.equal(pet.encounter, null, "but the offer is still consumed -- the flow ran");
});

test("only an explicit true counts as a test, so a real catch cannot be lost", () => {
  for (const flag of [undefined, null, false, 0, "true"]) {
    const pet = applyCaptureResults(base(), queue([{ species: A, outcome: "caught", test: flag }]), null);
    assert.equal(dexProgress(pet).capturedCount, 1, `test: ${JSON.stringify(flag)} must still record`);
  }
});

// --- a catch pays the whole collection ------------------------------------
//
// Owner, 2026-09-09: every pokemon you hold gains one heart's worth of EXP when
// anything is caught. Denominated in hearts so it is worth the same PROPORTION
// of every bar; see grantRosterExp in pet/roster.js.

const oneHeart = (level) => expToNextLevel(level) / 100;

test("a catch gives every pokemon you hold one heart of EXP", () => {
  const pet = applyCaptureResults({
    ...base(),
    dexCaught: [B],
    capturedCount: 1,
    box: [{ species: B, level: 20, exp: 3 }],
    encounter: { species: A, offeredAt: 1 },
  }, queue([{ species: A, outcome: "caught" }]), null);

  assert.equal(round(pet.exp), round(oneHeart(9)), "the buddy on the panel");
  assert.equal(round(boxPet(pet, B).exp), round(3 + oneHeart(20)), "the one already in the box");
});

test("the one just caught shares in the catch that brought it in", () => {
  const pet = applyCaptureResults({ ...base(), encounter: { species: A, offeredAt: 1 } },
    queue([{ species: A, outcome: "caught" }]), null);

  assert.equal(round(boxPet(pet, A).exp), round(oneHeart(5)));
});

// The point of hearts rather than points: the curve runs 6 EXP a level at the
// bottom to 42 at the top, so any flat number would mean something different at
// each end. A percentage of the bar means the same thing everywhere.
test("one heart is the same share of the bar at every level", () => {
  const pet = applyCaptureResults({
    ...base(),
    level: 1,
    box: [{ species: B, level: 99, exp: 0 }],
    encounter: { species: A, offeredAt: 1 },
  }, queue([{ species: A, outcome: "caught" }]), null);

  const shareOf = (exp, level) => exp / expToNextLevel(level);
  assert.equal(round(shareOf(pet.exp, 1)), round(shareOf(boxPet(pet, B).exp, 99)));
});

test("a miss pays nobody", () => {
  const before = { ...base(), level: 9, exp: 2, box: [{ species: B, level: 20, exp: 3 }],
    encounter: { species: A, offeredAt: 1 } };
  const pet = applyCaptureResults(before, queue([{ species: A, outcome: "escaped" }]), null);

  assert.equal(pet.exp, 2);
  assert.equal(boxPet(pet, B).exp, 3);
});

test("a test encounter pays nobody either", () => {
  const before = { ...base(), level: 9, exp: 2, encounter: { species: A, offeredAt: 1 } };
  const pet = applyCaptureResults(before, queue([{ species: A, outcome: "caught", test: true }]), null);

  assert.equal(pet.exp, 2);
});

// A duplicate does not enter the box, and a catch with a full box does not
// either. Both are still captures, and the reward is for the catching.
test("a duplicate still pays the collection", () => {
  const pet = applyCaptureResults({
    ...base(), level: 9, dexCaught: [A], capturedCount: 1,
    box: [{ species: A, level: 5, exp: 0 }], encounter: { species: A, offeredAt: 1 },
  }, queue([{ species: A, outcome: "caught" }]), null);

  assert.equal(pet.capturedCount, 2);
  assert.equal(pet.box.length, 1, "no second copy of a species");
  assert.equal(round(pet.exp), round(oneHeart(9)));
});

test("two catches in one tick pay twice", () => {
  const pet = applyCaptureResults({ ...base(), level: 9, encounter: { species: A, offeredAt: 1 } },
    queue([{ species: A, outcome: "caught" }, { species: B, outcome: "caught" }]), null);

  assert.equal(round(pet.exp), round(oneHeart(9) * 2));
});

// A form you have evolved past is a keepsake: displayed, not alive. It renders
// `Lv -`, so levelling it here would be growth nobody could see.
test("a keepsake in the box is not paid", () => {
  const pet = applyCaptureResults({
    ...base(),
    dexCaught: ["bulbasaur", "ivysaur"],
    capturedCount: 1,
    box: [{ species: "bulbasaur", level: 12, exp: 1 }],
    encounter: { species: A, offeredAt: 1 },
  }, queue([{ species: A, outcome: "caught" }]), null);

  assert.equal(boxPet(pet, "bulbasaur").exp, 1, "bulbasaur is a keepsake once ivysaur is owned");
});

// Inventing a level for a malformed row would write the invention to disk, and
// a box row has no other copy anywhere.
test("a box row with no level is left exactly as it was", () => {
  const pet = applyCaptureResults({
    ...base(),
    box: [{ species: "mystery", legacy: true }],
    encounter: { species: A, offeredAt: 1 },
  }, queue([{ species: A, outcome: "caught" }]), null);

  const row = pet.box.find((entry) => entry.species === "mystery");
  assert.deepEqual(row, { species: "mystery", legacy: true });
});

test("enough catches actually move a level, they do not vanish into rounding", () => {
  let pet = { ...base(), level: 5, exp: 0, encounter: null };
  for (let i = 0; i < 100; i += 1) {
    pet = applyCaptureResults(pet, queue([{ species: A, outcome: "caught" }]), null);
  }
  assert.equal(pet.level, 6, "one hundred hearts is one whole level");
});

function round(value) {
  return Math.round(Number(value) * 1e6) / 1e6;
}
