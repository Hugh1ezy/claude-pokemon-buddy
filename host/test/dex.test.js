import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BOX_MAX,
  boxPet,
  dexEntries,
  dexProgress,
  emptyDex,
  normalizeDex,
  recordCapture,
  recordSeen,
} from "../src/pet/dex.js";
import { loadState, saveState, SCHEMA_VERSION } from "../src/state.js";

const pet = (species, extra = {}) => ({ species, level: 1, exp: 0, bond: 0, ...extra });

test("a fresh dex is empty on all three counters", () => {
  const progress = dexProgress(emptyDex());
  assert.deepEqual(progress, { capturedCount: 0, dexCaught: 0, dexTotal: 151, boxCount: 0 });
});

test("a first capture unlocks the dex entry, the tally, and a box slot", () => {
  const result = recordCapture(emptyDex(), pet("pidgey"));
  assert.equal(result.isNewToDex, true);
  assert.equal(result.keptInBox, true);
  assert.equal(result.duplicate, false);
  assert.deepEqual(dexProgress(result.dex), {
    capturedCount: 1, dexCaught: 1, dexTotal: 151, boxCount: 1,
  });
});

test("catching the same species again moves only the capture tally", () => {
  const first = recordCapture(emptyDex(), pet("pidgey", { level: 9, bond: 40 })).dex;
  const second = recordCapture(first, pet("pidgey", { level: 1, bond: 0 }));

  assert.equal(second.duplicate, true);
  assert.equal(second.isNewToDex, false);
  assert.equal(second.keptInBox, false);
  assert.deepEqual(dexProgress(second.dex), {
    capturedCount: 2,   // a moved
    dexCaught: 1,       // b did not
    dexTotal: 151,
    boxCount: 1,        // and no second Pidgey was kept
  });

  // The whole point of the rule: the Pidgey that has been raised is untouched.
  assert.deepEqual(boxPet(second.dex, "pidgey"), pet("pidgey", { level: 9, bond: 40 }));
});

test("each box pet keeps its own level and bond -- they are not shared", () => {
  let dex = recordCapture(emptyDex(), pet("pidgey", { level: 9, bond: 40 })).dex;
  dex = recordCapture(dex, pet("rattata", { level: 3, bond: 5 })).dex;

  assert.equal(boxPet(dex, "pidgey").level, 9);
  assert.equal(boxPet(dex, "rattata").level, 3);
  assert.equal(boxPet(dex, "pidgey").bond, 40);
  assert.equal(boxPet(dex, "rattata").bond, 5);
});

test("the dex list is in dex order regardless of capture order", () => {
  let dex = emptyDex();
  for (const species of ["mew", "pikachu", "bulbasaur"]) dex = recordCapture(dex, pet(species)).dex;
  assert.deepEqual(normalizeDex(dex).dexCaught, ["bulbasaur", "pikachu", "mew"]);
});

test("dexEntries lists all 151 in order, uncaught ones flagged for the silhouette", () => {
  const dex = recordCapture(emptyDex(), pet("charmander")).dex;
  const entries = dexEntries(dex);

  assert.equal(entries.length, 151);
  assert.deepEqual(entries[0], { dex: 1, species: "bulbasaur", caught: false });
  assert.deepEqual(entries[3], { dex: 4, species: "charmander", caught: true });
  assert.deepEqual(entries[150], { dex: 151, species: "mew", caught: false });
  assert.equal(entries.filter((e) => e.caught).length, 1);
});

test("a full box still records the dex entry and the tally", () => {
  // Everything catchable is already kept; there is nowhere to put the next one.
  let dex = emptyDex();
  const filler = Array.from({ length: BOX_MAX }, (_, i) => dexEntries(dex)[i].species);
  for (const species of filler) dex = recordCapture(dex, pet(species)).dex;
  assert.equal(dexProgress(dex).boxCount, BOX_MAX);

  const overflow = recordCapture(dex, pet("mew"));
  assert.equal(overflow.keptInBox, false);
  assert.equal(dexProgress(overflow.dex).capturedCount, BOX_MAX + 1);
});

test("recordCapture refuses a species that is not a dex entry", () => {
  // The five legacy Eeveelutions are nameable and drawable but out of dex --
  // catching one would put a 152nd thing in a 151-slot pokedex.
  assert.throws(() => recordCapture(emptyDex(), pet("umbreon")), /not a dex species/);
  assert.throws(() => recordCapture(emptyDex(), pet("missingno")), /not a dex species/);
});

test("normalizeDex repairs junk instead of trusting or crashing on it", () => {
  const repaired = normalizeDex({
    dexCaught: ["pikachu", "pikachu", "missingno", 42, null, "bulbasaur"],
    capturedCount: -5,
    box: [
      { species: "pikachu", level: 5 },
      { species: "pikachu", level: 99 },   // duplicate box entry: first wins
      { species: "missingno" },            // not a real species
      null,
    ],
  });

  assert.deepEqual(repaired.dexCaught, ["bulbasaur", "pikachu"]);
  assert.equal(repaired.box.length, 1);
  assert.equal(repaired.box[0].level, 5);
  // A negative count is junk and gets floored -- at the BOX size, not the dex
  // size. See the seen-vs-caught test below for why those differ.
  assert.equal(repaired.capturedCount, 1);
});

// The bug row 4 exposed the day it was first drawn: the panel read 捕捉 2 on a
// buddy that had merely hatched and evolved once, with an empty box and no
// capture flow implemented at all. normalizeDex was flooring capturedCount at
// dexCaught.length, and recordSeen puts entries in dexCaught that are
// explicitly not captures.
test("recordSeen unlocks dex entries without inventing captures", () => {
  let dex = emptyDex();
  dex = recordSeen(dex, "bulbasaur");
  dex = recordSeen(dex, "ivysaur");

  const progress = dexProgress(dex);
  assert.equal(progress.dexCaught, 2, "both are owned and belong in the dex");
  assert.equal(progress.capturedCount, 0, "neither was caught");
  assert.equal(progress.boxCount, 0);

  // And it must survive the normalize a save round-trip puts it through, which
  // is where the invented captures were actually coming from.
  assert.equal(normalizeDex(dex).capturedCount, 0);
});

test("normalizeDex keeps a legitimately higher capturedCount", () => {
  const repaired = normalizeDex({ dexCaught: ["pidgey"], capturedCount: 17, box: [] });
  assert.equal(repaired.capturedCount, 17);
});

test("normalizeDex turns a missing or malformed dex into an empty one", () => {
  for (const input of [undefined, null, {}, { dexCaught: "nope", box: 7 }]) {
    assert.deepEqual(normalizeDex(input), emptyDex());
  }
});

// --- save round-trip: the cross-machine safety property -----------------

function statePath(name) {
  mkdirSync("out", { recursive: true });
  const path = join("out", `test-dex-${name}.json`);
  rmSync(path, { force: true });
  rmSync(`${path}.bak`, { force: true });
  return path;
}

test("the dex survives a load/save round trip", () => {
  const path = statePath("roundtrip");
  const dex = recordCapture(recordCapture(emptyDex(), pet("pidgey", { level: 9 })).dex, pet("pidgey")).dex;
  saveState(path, { species: "bulbasaur", level: 9, hatched: true, ...dex });

  const loaded = loadState(path);
  assert.deepEqual(loaded.dexCaught, ["pidgey"]);
  assert.equal(loaded.capturedCount, 2);
  assert.equal(loaded.box[0].level, 9);
  assert.equal(loaded.species, "bulbasaur");
});

// The property the whole no-version-bump decision rests on. Older code reads a
// save the same way this does -- exact schemaVersion match, then normalizePet,
// which copies the object and only touches keys it knows about. If that ever
// stops being true, the other machine starts eating the pokedex and pushing
// the stripped save back through save-sync, with no error anywhere.
test("an unrecognised field is carried through load and save untouched", () => {
  const path = statePath("unknown-fields");
  saveState(path, { species: "bulbasaur", level: 9, hatched: true, somethingFromTheFuture: { a: 1 } });

  const loaded = loadState(path);
  assert.deepEqual(loaded.somethingFromTheFuture, { a: 1 });

  saveState(path, loaded);
  const reread = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(reread.somethingFromTheFuture, { a: 1 });
  assert.equal(reread.schemaVersion, SCHEMA_VERSION);
});

test("a save with no dex at all stays byte-identical through a round trip", () => {
  const path = statePath("no-dex");
  const before = { species: "bulbasaur", level: 9, exp: 3, bond: 40, hatched: true };
  saveState(path, before);
  const first = readFileSync(path, "utf8");

  saveState(path, loadState(path));
  assert.equal(readFileSync(path, "utf8"), first);
});

test("a corrupted save salvages the pokedex rather than dropping it", () => {
  const path = statePath("corrupt");
  // Wrong schemaVersion forces the salvage path -- the one that used to keep
  // only whitelisted keys and would have thrown the dex away.
  writeFileSync(path, JSON.stringify({
    schemaVersion: 999,
    species: "bulbasaur",
    level: 9,
    dexCaught: ["pikachu", "pidgey"],
    capturedCount: 12,
    box: [{ species: "pidgey", level: 4 }],
  }));

  const loaded = loadState(path, { logger: { warn() {} } });
  assert.deepEqual(loaded.dexCaught, ["pidgey", "pikachu"]);
  assert.equal(loaded.capturedCount, 12);
  assert.equal(loaded.box[0].level, 4);
  assert.equal(loaded.level, 9);
});
