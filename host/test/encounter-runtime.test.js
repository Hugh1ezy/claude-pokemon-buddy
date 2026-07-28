import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyEncounterTick } from "../src/index.js";
import { buildEncounterContext, isNight, weekdayKey } from "../src/pet/encounter-context.js";
import { loadEncounterTable, resetEncounterTableCache } from "../src/pet/encounter-table.js";
import { evolutionRoot } from "../src/pet/species-meta.js";
import { loadState, saveState } from "../src/state.js";

// No species-condition pairs anywhere in this file, by the same rule the engine
// tests follow: the conditions are the mechanism and may be named, the table is
// content and may not. Every fixture below invents its own species entries.
const QUIET = { log() {}, warn() {} };
const NOW = new Date(2026, 6, 28, 21, 30);   // Tue evening, local

test("evolutionRoot walks back to what hatched, and stops at a species that never evolved", () => {
  assert.equal(evolutionRoot("venusaur"), "bulbasaur");
  assert.equal(evolutionRoot("charmeleon"), "charmander");
  assert.equal(evolutionRoot("bulbasaur"), "bulbasaur");
  // The Eeveelutions live outside pokedex.json and still have to find their way home.
  assert.equal(evolutionRoot("umbreon"), "eevee");
  assert.equal(evolutionRoot("sylveon"), "eevee");
  // Not a species at all: answer with the question rather than undefined.
  assert.equal(evolutionRoot("nonesuch"), "nonesuch");
});

test("the context reports what is known and withholds what is not", () => {
  const ctx = buildEncounterContext({
    pet: { species: "ivysaur", level: 9, bond: 10.4, streak: 3, careCount: 3, dexCaught: ["pidgey"] },
    usage: { p5h: 42, pweek: 61 },
    weather: { kind: "rain", temp: 14, humidity: 88, wind: 20 },
    room: { temp: 19, battery: 55 },
    mood: "focused",
    now: NOW,
  });

  assert.equal(ctx.weatherKind, "rain");
  assert.equal(ctx.roomTemp, 19);
  assert.equal(ctx.battery, 55);
  assert.equal(ctx.starter, "bulbasaur");     // not the ivysaur on the panel
  assert.equal(ctx.dexCaught, 1);
  assert.deepEqual(ctx.caughtList, ["pidgey"]);
  assert.equal(ctx.weekday, "tue");
  assert.equal(ctx.night, true);
  assert.equal(ctx.daytime, false);
  assert.equal(ctx.hour, 21);
});

test("a reading that has not arrived is null, never a stand-in zero", () => {
  const ctx = buildEncounterContext({ pet: { species: "eevee" }, now: NOW });

  // 0 would silently satisfy every "atLeast: 0" style condition and defeat
  // tempBelow/usageBelow outright -- these must be absent, not cold.
  for (const field of ["temp", "humidity", "wind", "roomTemp", "battery", "p5h", "pweek"]) {
    assert.equal(ctx[field], null, `${field} should be null when unknown`);
  }
  assert.equal(ctx.weatherKind, null);
  assert.equal(ctx.mood, null);
});

test("a degraded weather snapshot gates weather-conditioned species off, not on", () => {
  // What weather.js actually hands over when the fetch failed: partial, and
  // carrying no `kind` key at all.
  const ctx = buildEncounterContext({
    pet: { species: "eevee" },
    weather: { cond: "—", temp: null, degraded: true },
    now: NOW,
  });

  assert.equal(ctx.weatherKind, null);
  assert.equal(ctx.temp, null);
});

test("weekday and night keys line up with what the conditions ask for", () => {
  assert.equal(weekdayKey(new Date(2026, 6, 26)), "sun");
  assert.equal(weekdayKey(new Date(2026, 6, 25)), "sat");
  assert.equal(isNight(23), true);
  assert.equal(isNight(3), true);
  assert.equal(isNight(12), false);
  assert.equal(isNight(6), false);
});

test("the real table loads, is cached, and carries a weight for every species", () => {
  resetEncounterTableCache();
  const table = loadEncounterTable();

  assert.ok(table.species.length > 0);
  assert.ok(Number.isFinite(table.caughtWeight));
  assert.ok(table.species.every((entry) => typeof entry.species === "string" && entry.weight > 0));
  assert.equal(loadEncounterTable(), table, "expected the second load to be cached");
});

test("an unreadable table disables encounters instead of breaking the tick", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cpb-enc-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); resetEncounterTableCache(); });
  const path = join(dir, "encounters.json");
  writeFileSync(path, "{ truncated");

  resetEncounterTableCache();
  assert.throws(() => loadEncounterTable({ path }), /encounter table could not be read/);
  // The message must not quote the file: a JSON parse error prints the offending
  // text, and here that text is table content.
  try {
    loadEncounterTable({ path });
  } catch (error) {
    assert.doesNotMatch(error.message, /truncated/);
  }
});

test("the tick records the buddy's own line in the dex without counting it as a capture", () => {
  const pet = { species: "ivysaur", level: 9, hatched: true };

  const next = applyEncounterTick(pet, { usage: {}, weather: {}, now: NOW, rng: () => 1, logger: QUIET });

  assert.deepEqual(next.dexCaught, ["ivysaur"]);
  assert.equal(next.capturedCount, 0, "owning is not catching");
  assert.deepEqual(next.box, [], "the buddy on the panel is not a second copy in the box");
});

test("a tick with nothing to say leaves the save byte-identical", () => {
  // Already recorded, and an rng that never fires an encounter.
  const pet = { species: "ivysaur", dexCaught: ["ivysaur"], capturedCount: 0, box: [] };

  const next = applyEncounterTick(pet, { usage: {}, weather: {}, now: NOW, rng: () => 1, logger: QUIET });

  assert.equal(JSON.stringify(next), JSON.stringify(pet));
});

test("an offer survives a host restart through the save", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cpb-enc-save-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "state.json");

  saveState(file, {
    species: "eevee", hatched: true,
    encounter: { species: "pidgey", offeredAt: 1_700_000_000_000 },
  });

  assert.deepEqual(loadState(file).encounter, { species: "pidgey", offeredAt: 1_700_000_000_000 });
});

test("an offer with no timestamp is dropped, because nothing could ever expire it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cpb-enc-save2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "state.json");

  saveState(file, {
    species: "eevee", hatched: true,
    encounter: { species: "pidgey", lastEndedAt: 1_700_000_000_000 },
  });

  const loaded = loadState(file);
  assert.equal(loaded.encounter.species, null, "a species that can never leave must not be kept");
  assert.equal(loaded.encounter.lastEndedAt, 1_700_000_000_000, "the cooldown is still good");
});

test("a save that has never seen an encounter round-trips untouched", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cpb-enc-save3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "state.json");

  saveState(file, { species: "eevee", level: 4, hatched: true });
  const loaded = loadState(file);

  assert.ok(!("encounter" in loaded), "no encounter key should be invented");
});
