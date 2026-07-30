import { test } from "node:test";
import assert from "node:assert/strict";

import { applyCaptureResults } from "../src/index.js";
import { dexProgress } from "../src/pet/dex.js";
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
