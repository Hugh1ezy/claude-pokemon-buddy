// ⚠️ SPOILERS in the output — 主人请勿运行 / owner: do not run this ⚠️
//
// Runs the real encounter engine over simulated time and reports how long the
// pokedex takes to fill. This exists because "roughly six months to a year" is
// a claim about a stochastic system with 151 gated weights, and the only
// honest way to make that claim is to run it.
//
// Run from host/: node scripts/sim-encounters.mjs [runs] [days]
//
// The simulated day follows the owner's actual routine (docs: work ~09-17,
// home until ~24:00, device powered throughout), with weather and room
// conditions drawn from an Auckland-ish year so the weather-gated species get
// realistic -- not generous -- opportunities.
import { readFileSync } from "node:fs";

import { ENCOUNTER_DEFAULTS, stepEncounter } from "../src/pet/encounter.js";
import { recordCapture, recordSeen, emptyDex } from "../src/pet/dex.js";

const TABLE = JSON.parse(readFileSync(new URL("../seed/encounters.json", import.meta.url), "utf8"));
const RUNS = Number(process.argv[2] ?? 40);
const DAYS = Number(process.argv[3] ?? 400);

// Deterministic PRNG so a re-run of the same seed reproduces exactly; a tuning
// change should show up as a different curve, not as noise.
function mulberry32(seed) {
  return function rng() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Auckland: mild, wet, rarely freezing. Rough monthly shape is enough -- the
// point is that snow is nearly absent and rain is common, which is what
// actually gates the water and ice species.
function weatherFor(day, rng) {
  const season = Math.cos((day / 365) * 2 * Math.PI);      // +1 = midwinter (southern)
  const rainChance = 0.34 + 0.12 * season;
  const roll = rng();
  if (roll < rainChance) return "rain";
  if (roll < rainChance + 0.04 + 0.05 * season) return "fog";
  if (roll < rainChance + 0.30) return "cloud";
  if (season > 0.85 && rng() < 0.02) return "snow";         // Auckland: essentially never
  return "sun";
}

function simulate(seed) {
  const rng = mulberry32(seed);
  // The owner hatched bulbasaur and will evolve it; those three entries come
  // from owning it, not from catching it.
  let dex = emptyDex();
  for (const own of ["bulbasaur", "ivysaur", "venusaur"]) dex = recordSeen(dex, own);
  let state = null;
  let now = 0;
  let encounters = 0;
  let escaped = 0;
  const firstCaughtDay = new Map();

  for (let day = 0; day < DAYS; day += 1) {
    const weatherKind = weatherFor(day, rng);
    const season = Math.cos((day / 365) * 2 * Math.PI);
    const temp = 15 - 6 * season + (rng() * 8 - 4);
    const humidity = 60 + (weatherKind === "rain" ? 18 : 0) + rng() * 15;
    const wind = 8 + rng() * 30;
    const weekday = WEEKDAYS[day % 7];
    const bond = Math.min(180, 20 + day * 0.5);
    const streak = day;

    // 09:00 -> 24:00, one tick a minute.
    for (let minute = 9 * 60; minute < 24 * 60; minute += 1) {
      now = day * 86_400_000 + minute * 60_000;
      const hour = Math.floor(minute / 60);
      const ctx = {
        hour, daytime: hour >= 6 && hour < 18, night: !(hour >= 6 && hour < 18),
        weatherKind, temp, humidity, wind,
        roomTemp: 19 - 3 * season + rng() * 6,
        battery: 40 + rng() * 60,
        bond, level: Math.min(50, 9 + Math.floor(day / 8)), streak,
        careCount: Math.floor(day * 1.5),
        dexCaught: dex.dexCaught.length,
        caughtList: dex.dexCaught,
        p5h: rng() * 100, pweek: 30 + rng() * 50,
        mood: rng() < 0.1 ? "strained" : "focused",
        weekday,
        starter: "bulbasaur",
      };

      const stepped = stepEncounter({ table: TABLE, dex, ctx, state, now, rng, options: ENCOUNTER_DEFAULTS });
      if (stepped.escaped) escaped += 1;
      // A new offer this tick. Assume the owner is present and catches it most
      // of the time -- being away is what the escape path already models.
      if (stepped.state.species && stepped.state.species !== state?.species) {
        encounters += 1;
        if (rng() < 0.75) {
          const before = dex.dexCaught.length;
          dex = recordCapture(dex, { species: stepped.state.species, level: 5 }).dex;
          if (dex.dexCaught.length > before) firstCaughtDay.set(stepped.state.species, day);
          stepped.state = { species: null, lastEndedAt: now };
        }
      }
      state = stepped.state;
      if (dex.dexCaught.length === 151) {
        return { completedDay: day, encounters, escaped, firstCaughtDay, caught: 151 };
      }
    }
  }
  return { completedDay: null, encounters, escaped, firstCaughtDay, caught: dex.dexCaught.length };
}

const results = [];
for (let i = 0; i < RUNS; i += 1) results.push(simulate(1000 + i));

const completed = results.filter((r) => r.completedDay != null).map((r) => r.completedDay).sort((a, b) => a - b);
const pct = (p) => (completed.length ? completed[Math.min(completed.length - 1, Math.floor(completed.length * p))] : null);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

console.log(`runs: ${RUNS}, horizon: ${DAYS} days`);
console.log(`completed within horizon: ${completed.length}/${RUNS}`);
if (completed.length > 0) {
  console.log(`days to 151/151 -- fastest ${completed[0]}, p25 ${pct(0.25)}, median ${pct(0.5)}, p75 ${pct(0.75)}, slowest ${completed[completed.length - 1]}`);
  console.log(`               -- median ≈ ${(pct(0.5) / 30.4).toFixed(1)} months`);
}
console.log(`encounters offered: mean ${mean(results.map((r) => r.encounters)).toFixed(0)} (${(mean(results.map((r) => r.encounters)) / mean(results.map((r) => r.completedDay ?? DAYS))).toFixed(2)}/day)`);
console.log(`escaped (not caught in time): mean ${mean(results.map((r) => r.escaped)).toFixed(0)}`);

// Which entries are the long pole -- the ones worth re-tuning if the tail is
// too long. Averaged over runs that finished.
const lastCaught = new Map();
for (const r of results) {
  for (const [species, day] of r.firstCaughtDay) {
    lastCaught.set(species, (lastCaught.get(species) ?? 0) + day / RUNS);
  }
}
const slowest = [...lastCaught.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log(`\nslowest 12 (mean day first caught):`);
for (const [species, day] of slowest) console.log(`  ${species.padEnd(14)} ${day.toFixed(0)}`);

// The list that matters when a run does not finish: not "which was slow" but
// "which never happened at all", i.e. which gate is unreachable in this
// climate. A condition that reads well and cannot fire is the failure mode
// this whole script exists to catch.
const everCaught = new Set();
for (const r of results) for (const species of r.firstCaughtDay.keys()) everCaught.add(species);
const neverCaught = TABLE.species.map((s) => s.species).filter((s) => !everCaught.has(s));
if (neverCaught.length > 0) {
  console.log(`\nNEVER caught in any of ${RUNS} runs (${neverCaught.length}):`);
  for (const species of neverCaught) {
    const needs = TABLE.species.find((s) => s.species === species)?.needs ?? {};
    console.log(`  ${species.padEnd(14)} ${JSON.stringify(needs)}`);
  }
}
if (completed.length < RUNS) console.log(`\n${RUNS - completed.length} run(s) did not finish; sample ended at ${results.find((r) => r.completedDay == null)?.caught}/151`);
