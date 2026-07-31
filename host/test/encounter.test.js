import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ENCOUNTER_DEFAULTS, eligibleSpecies, rollEncounter, stepEncounter } from "../src/pet/encounter.js";
import { emptyDex } from "../src/pet/dex.js";
import { SPECIES_ORDER } from "../src/pet/species-meta.js";

// These tests are about the MECHANISM only. They never assert that a named
// species needs a named condition -- the owner asked to be surprised, and a
// test name is as much of a spoiler as a design doc. Fixtures below use
// invented gates on arbitrary species for exactly that reason.
const TABLE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../seed/encounters.json", import.meta.url)), "utf8"),
);

const fixture = {
  caughtWeight: 0.1,
  species: [
    { species: "pidgey", weight: 100 },
    { species: "rattata", weight: 100 },
    { species: "gastly", weight: 10, needs: { night: true } },
    { species: "lapras", weight: 1, needs: { weather: ["rain"], tempBelow: 10 } },
  ],
};

const always = () => 0;      // rng that always picks the first branch
const never = () => 0.999;

// Everything the playable evolution table can deliver. Read from the same place
// the generator reads it, so the two cannot drift into disagreeing about which
// species a zero weight is safe for.
const EVOLUTION_TARGETS = (() => {
  const dir = new URL("../seed/evolution/", import.meta.url);
  const targets = new Set();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const table = JSON.parse(readFileSync(fileURLToPath(new URL(file, dir)), "utf8"));
    for (const node of Object.values(table)) {
      for (const branch of node.branches ?? []) targets.add(branch.to);
    }
  }
  return targets;
})();

test("the shipped table covers all 151, and nothing is stranded", () => {
  assert.equal(TABLE.species.length, 151);
  assert.deepEqual(TABLE.species.map((s) => s.species), SPECIES_ORDER);
  assert.ok(TABLE.species.every((s) => typeof s.weight === "number" && s.weight >= 0));

  // A zero weight means "the wild will never offer this; evolve into it
  // instead", so every one of them has to actually BE reachable that way. This
  // is the guard that matters: the naive version of the exclusion rule stranded
  // 27 species permanently, and nothing at runtime would ever have said so.
  //
  // Counts only, no names -- this file is safe to read and stays that way.
  const zero = TABLE.species.filter((s) => s.weight === 0).map((s) => s.species);
  const stranded = zero.filter((species) => !EVOLUTION_TARGETS.has(species));
  assert.deepEqual(stranded, [], `${stranded.length} species can be obtained no way at all`);
});

test("the shipped table uses only conditions the engine understands", () => {
  // A typo'd condition key would make that species unreachable forever, and
  // nothing at runtime would say so -- conditionsMet treats unknown keys as
  // never-satisfied on purpose, so this is the only place it can be caught.
  const known = new Set(Object.keys(probePredicates()));
  const unknown = new Set();
  for (const entry of TABLE.species) {
    for (const key of Object.keys(entry.needs ?? {})) if (!known.has(key)) unknown.add(key);
  }
  assert.deepEqual([...unknown], []);
});

test("a species whose conditions are unmet is not eligible", () => {
  const day = eligibleSpecies(fixture, emptyDex(), { night: false, daytime: true });
  assert.deepEqual(day.map((c) => c.species), ["pidgey", "rattata"]);

  const night = eligibleSpecies(fixture, emptyDex(), { night: true, daytime: false });
  assert.ok(night.some((c) => c.species === "gastly"));
});

test("every condition in a needs block must hold, not just one", () => {
  const ctx = { weather: "rain", weatherKind: "rain", temp: 20 };   // right weather, wrong temperature
  assert.ok(!eligibleSpecies(fixture, emptyDex(), ctx).some((c) => c.species === "lapras"));

  const cold = { weatherKind: "rain", temp: 4 };
  assert.ok(eligibleSpecies(fixture, emptyDex(), cold).some((c) => c.species === "lapras"));
});

test("a missing context value fails its condition instead of throwing", () => {
  // A tick before the first weather fetch has no temperature at all. That must
  // mean "no weather-gated encounter right now", never a crash in the tick.
  assert.doesNotThrow(() => eligibleSpecies(fixture, emptyDex(), {}));
  assert.deepEqual(eligibleSpecies(fixture, emptyDex(), {}).map((c) => c.species), ["pidgey", "rattata"]);
});

test("an unknown condition key never fires rather than always firing", () => {
  const table = { species: [{ species: "pidgey", weight: 100, needs: { somethingNew: true } }] };
  assert.deepEqual(eligibleSpecies(table, emptyDex(), { somethingNew: true }), []);
});

test("an already-caught species stays in the pool at reduced weight", () => {
  const dex = { dexCaught: ["pidgey"], capturedCount: 1, box: [] };
  const pool = eligibleSpecies(fixture, dex, { daytime: true });
  const pidgey = pool.find((c) => c.species === "pidgey");
  const rattata = pool.find((c) => c.species === "rattata");

  assert.equal(pidgey.weight, 100 * fixture.caughtWeight);
  assert.equal(rattata.weight, 100);
  // Still in the pool: duplicates are what the capture tally counts.
  assert.ok(pidgey.weight > 0);
});

test("rollEncounter respects weights", () => {
  assert.equal(rollEncounter(fixture, emptyDex(), { daytime: true }, always), "pidgey");
  assert.equal(rollEncounter(fixture, emptyDex(), { daytime: true }, never), "rattata");
});

test("rollEncounter returns null when nothing is eligible", () => {
  const table = { species: [{ species: "gastly", weight: 10, needs: { night: true } }] };
  assert.equal(rollEncounter(table, emptyDex(), { night: false }, always), null);
});

test("an offer expires into an escape, and the cooldown starts when it left", () => {
  const offeredAt = 1_000_000;
  const state = { species: "pidgey", offeredAt };
  const at = offeredAt + ENCOUNTER_DEFAULTS.offerMs;

  const stepped = stepEncounter({ table: fixture, dex: emptyDex(), ctx: { daytime: true }, state, now: at, rng: always });
  assert.equal(stepped.escaped, "pidgey");
  assert.equal(stepped.state.species, null);
  assert.equal(stepped.state.lastEndedAt, at);

  // Immediately after the escape, nothing new -- otherwise missing one is
  // instantly compensated and the loss means nothing.
  const next = stepEncounter({
    table: fixture, dex: emptyDex(), ctx: { daytime: true },
    state: stepped.state, now: at + 1000, rng: always,
  });
  assert.equal(next.state.species, null);
});

test("a live offer is left alone rather than replaced", () => {
  const state = { species: "pidgey", offeredAt: 1_000_000 };
  const stepped = stepEncounter({
    table: fixture, dex: emptyDex(), ctx: { daytime: true },
    state, now: 1_000_000 + 1000, rng: always,
  });
  assert.equal(stepped.state, state);
  assert.equal(stepped.escaped, null);
});

test("no encounter is offered while the cooldown is running", () => {
  const state = { species: null, lastEndedAt: 5_000_000 };
  const stepped = stepEncounter({
    table: fixture, dex: emptyDex(), ctx: { daytime: true },
    state, now: 5_000_000 + ENCOUNTER_DEFAULTS.cooldownMs - 1, rng: always,
  });
  assert.equal(stepped.state.species, null);
});

test("past the cooldown, a winning roll produces an offer stamped with the time", () => {
  const state = { species: null, lastEndedAt: 5_000_000 };
  const now = 5_000_000 + ENCOUNTER_DEFAULTS.cooldownMs;
  const stepped = stepEncounter({
    table: fixture, dex: emptyDex(), ctx: { daytime: true }, state, now, rng: always,
  });
  assert.equal(stepped.state.species, "pidgey");
  assert.equal(stepped.state.offeredAt, now);
});

test("a losing roll leaves the state untouched", () => {
  const state = { species: null, lastEndedAt: 0 };
  const stepped = stepEncounter({
    table: fixture, dex: emptyDex(), ctx: { daytime: true }, state, now: 9_999_999, rng: never,
  });
  assert.equal(stepped.state.species, null);
});

test("stepEncounter rejects a non-timestamp now", () => {
  assert.throws(() => stepEncounter({ table: fixture, dex: emptyDex(), ctx: {}, now: undefined }), /timestamp/);
});

// Mirrors the engine's predicate table without importing its internals, so a
// condition key added to the data file but not to the engine is caught above.
function probePredicates() {
  return {
    night: 1, daytime: 1, hourFrom: 1, hourBefore: 1, weather: 1,
    tempAtLeast: 1, tempBelow: 1, humidityAtLeast: 1, windAtLeast: 1,
    roomTempAtLeast: 1, roomTempBelow: 1, bondAtLeast: 1, levelAtLeast: 1,
    streakAtLeast: 1, careAtLeast: 1, dexAtLeast: 1, usageAtLeast: 1,
    usageBelow: 1, weekUsageAtLeast: 1, mood: 1, weekday: 1, batteryBelow: 1,
    notTheStarter: 1, caughtAll: 1,
  };
}
