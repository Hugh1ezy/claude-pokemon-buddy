import { test } from "node:test";
import assert from "node:assert/strict";

import { evolvePet } from "../src/pet/transitions.js";

// The owner's rule, 2026-08-03, given in the form of a question about his own
// buddy: an abra that reaches its evolution level while a kadabra is already in
// the box. Species names here are Gen-1 public knowledge and the line is the one
// he raised himself, so naming them is not a spoiler.
const base = {
  species: "abra",
  level: 16,
  exp: 0.5,
  bond: 15,
  iv: [1, 2, 3, 4, 5, 6],
  nature: "慢性子",
  characteristic: "爱睡觉",
  caughtAt: "2026-07-31",
  dexCaught: ["abra"],
  capturedCount: 4,
  box: [],
  readyToEvolve: true,
};

test("evolving lights the new dex entry and leaves 捕捉 alone", () => {
  const next = evolvePet(base, "kadabra");

  assert.equal(next.species, "kadabra");
  assert.ok(next.dexCaught.includes("kadabra"), "图鉴 gains the new form");
  assert.equal(next.capturedCount, 4, "捕捉 does not move -- nothing was caught");
  assert.equal(next.readyToEvolve, false);
});

test("a form already in the dex is not counted twice", () => {
  const next = evolvePet({ ...base, dexCaught: ["abra", "kadabra"] }, "kadabra");

  assert.deepEqual(next.dexCaught.filter((s) => s === "kadabra").length, 1);
  assert.equal(next.capturedCount, 4);
});

test("evolving into a species already in the box keeps the HIGHER level one", () => {
  const boxed = {
    species: "kadabra", level: 30, exp: 2.5, bond: 40,
    iv: [9, 9, 9, 9, 9, 9], nature: "急性子", characteristic: "很有活力", caughtAt: "2026-08-01",
  };
  const next = evolvePet({ ...base, dexCaught: ["abra", "kadabra"], box: [boxed] }, "kadabra");

  assert.equal(next.level, 30, "the boxed one was higher, so it survives");
  assert.equal(next.nature, "急性子", "and it brings its own identity with it");
  assert.equal(next.bond, 40);
  assert.equal(next.caughtAt, "2026-08-01");
});

test("the freshly evolved one survives when it is the higher level", () => {
  const boxed = { species: "kadabra", level: 9, exp: 0, bond: 1, iv: [0, 0, 0, 0, 0, 0], nature: "急性子" };
  const next = evolvePet({ ...base, dexCaught: ["abra", "kadabra"], box: [boxed] }, "kadabra");

  assert.equal(next.level, 16);
  assert.equal(next.nature, "慢性子", "the one that just evolved keeps its own identity");
});

test("a tie keeps the one that just evolved", () => {
  const boxed = { species: "kadabra", level: 16, exp: 9, bond: 99, nature: "急性子" };
  const next = evolvePet({ ...base, dexCaught: ["abra", "kadabra"], box: [boxed] }, "kadabra");

  assert.equal(next.nature, "慢性子");
  assert.equal(next.bond, 15);
});

// The state that must not exist: the species on the panel AND a copy in the box.
// rosterEntries() would render one of them and silently strand the other, which
// from outside looks like a pokemon that lost its levels.
test("no boxed copy of the species survives the evolution, either way round", () => {
  for (const level of [9, 30]) {
    const boxed = { species: "kadabra", level, exp: 0, bond: 1, nature: "急性子" };
    const next = evolvePet({ ...base, dexCaught: ["abra", "kadabra"], box: [boxed] }, "kadabra");
    assert.equal(next.box.filter((e) => e.species === "kadabra").length, 0, `boxed level ${level}`);
  }
});

test("other species in the box are untouched", () => {
  const other = { species: "arbok", level: 12, exp: 0, bond: 3, nature: "顽皮" };
  const next = evolvePet({ ...base, box: [other] }, "kadabra");

  assert.deepEqual(next.box, [other]);
});

test("evolving into a species with nothing boxed behaves exactly as before", () => {
  const next = evolvePet(base, "kadabra");

  assert.equal(next.level, 16);
  assert.equal(next.nature, "慢性子");
  assert.equal(next.box.length, 0);
});
