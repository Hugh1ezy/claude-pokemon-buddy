// Wild encounters: whether one happens this tick, and if so which species.
//
// Pure and deterministic given (table, dex, context, rng). No I/O, no clock of
// its own -- everything it needs is passed in, so the whole system is testable
// without a device and a simulation can run a year of it in a second
// (scripts/sim-encounters.mjs, which is how the pacing numbers below were
// arrived at rather than guessed).
//
// WHICH species requires WHICH conditions lives in seed/encounters.json, built
// by scripts/gen-encounters.mjs. That split is deliberate: this file is the
// mechanism and is meant to be read; that file is the content and is meant to
// be a surprise.

const MINUTE = 60_000;

export const ENCOUNTER_DEFAULTS = {
  // Rolled once per host tick (~60s). 0.0028 x ~900 waking ticks/day lands
  // near 2.5 encounters a day; see sim-encounters.mjs for what that does to
  // the completion curve.
  perTickChance: 0.0065,
  // Nothing new while one is already on offer, and a quiet spell afterwards so
  // a busy afternoon cannot turn into a queue of notifications.
  cooldownMs: 40 * MINUTE,
  // How long the row 3 notification blinks before the encounter is gone.
  // "Escaped" is a real outcome, not a failure state -- it is what makes a
  // rare one worth stopping for.
  offerMs: 5 * MINUTE,
  // Already-caught species stay in the pool (the tally counts duplicates) but
  // at a fraction of their weight, so the pool drifts toward what is missing.
  // Without this the last twenty entries take longer than the first hundred.
  caughtWeight: 0.008,
};

// ctx carries only what the device can actually observe. Anything not supplied
// simply fails the conditions that need it rather than throwing: a tick with no
// weather yet should mean "no weather-gated encounter right now", not a crash.
export function eligibleSpecies(table, dex, ctx) {
  const caught = new Set(dex?.dexCaught ?? []);
  const out = [];
  for (const entry of table.species) {
    if (!conditionsMet(entry.needs, ctx)) continue;
    const weight = entry.weight * (caught.has(entry.species) ? (table.caughtWeight ?? ENCOUNTER_DEFAULTS.caughtWeight) : 1);
    if (weight > 0) out.push({ species: entry.species, weight });
  }
  return out;
}

export function rollEncounter(table, dex, ctx, rng = Math.random) {
  const candidates = eligibleSpecies(table, dex, ctx);
  if (candidates.length === 0) return null;

  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  let pick = rng() * total;
  for (const candidate of candidates) {
    pick -= candidate.weight;
    if (pick <= 0) return candidate.species;
  }
  return candidates[candidates.length - 1].species;   // float drift only
}

// The tick entry point. Returns the next encounter state; the caller persists
// it and renders from it.
export function stepEncounter({
  table,
  dex,
  ctx,
  state = null,
  now,
  rng = Math.random,
  options = ENCOUNTER_DEFAULTS,
} = {}) {
  const at = Number(now);
  if (!Number.isFinite(at)) throw new Error("stepEncounter: now must be a timestamp");

  // An offer that ran out of time: the species leaves, and the cooldown starts
  // from the moment it left rather than from when it appeared -- otherwise a
  // missed encounter is immediately followed by another one.
  if (state?.species && at - state.offeredAt >= options.offerMs) {
    return { state: { species: null, lastEndedAt: at }, escaped: state.species };
  }
  if (state?.species) return { state, escaped: null };

  const since = state?.lastEndedAt ?? -Infinity;
  if (at - since < options.cooldownMs) return { state: state ?? { species: null }, escaped: null };
  if (rng() >= options.perTickChance) return { state: state ?? { species: null }, escaped: null };

  const species = rollEncounter(table, dex, ctx, rng);
  if (!species) return { state: state ?? { species: null }, escaped: null };
  return { state: { species, offeredAt: at }, escaped: null };
}

// Every predicate the condition table may use. Adding one here is the only way
// to make a new kind of condition expressible, which keeps the data file from
// quietly depending on something the device cannot measure.
const PREDICATES = {
  night: (v, ctx) => bool(v, ctx.night),
  daytime: (v, ctx) => bool(v, ctx.daytime),
  hourFrom: (v, ctx) => Number.isInteger(ctx.hour) && ctx.hour >= v,
  hourBefore: (v, ctx) => Number.isInteger(ctx.hour) && ctx.hour < v,
  weather: (v, ctx) => matchesAny(v, ctx.weatherKind),
  tempAtLeast: (v, ctx) => num(ctx.temp) && ctx.temp >= v,
  tempBelow: (v, ctx) => num(ctx.temp) && ctx.temp < v,
  humidityAtLeast: (v, ctx) => num(ctx.humidity) && ctx.humidity >= v,
  windAtLeast: (v, ctx) => num(ctx.wind) && ctx.wind >= v,
  roomTempAtLeast: (v, ctx) => num(ctx.roomTemp) && ctx.roomTemp >= v,
  roomTempBelow: (v, ctx) => num(ctx.roomTemp) && ctx.roomTemp < v,
  bondAtLeast: (v, ctx) => num(ctx.bond) && ctx.bond >= v,
  levelAtLeast: (v, ctx) => num(ctx.level) && ctx.level >= v,
  streakAtLeast: (v, ctx) => num(ctx.streak) && ctx.streak >= v,
  careAtLeast: (v, ctx) => num(ctx.careCount) && ctx.careCount >= v,
  dexAtLeast: (v, ctx) => num(ctx.dexCaught) && ctx.dexCaught >= v,
  usageAtLeast: (v, ctx) => num(ctx.p5h) && ctx.p5h >= v,
  usageBelow: (v, ctx) => num(ctx.p5h) && ctx.p5h < v,
  weekUsageAtLeast: (v, ctx) => num(ctx.pweek) && ctx.pweek >= v,
  mood: (v, ctx) => matchesAny(v, ctx.mood),
  weekday: (v, ctx) => matchesAny(v, ctx.weekday),
  batteryBelow: (v, ctx) => num(ctx.battery) && ctx.battery < v,
  // "This is not the one you chose." Makes a road-not-taken gate expressible
  // without the table having to name the buddy that was actually picked.
  notTheStarter: (v, ctx) => (v ? ctx.starter !== v : true),
  // Everything listed must already be in the pokedex -- a late-game gate that
  // rides on progress rather than on the weather.
  caughtAll: (v, ctx) => {
    const caught = new Set(ctx.caughtList ?? []);
    return (Array.isArray(v) ? v : [v]).every((key) => caught.has(key));
  },
};

function conditionsMet(needs, ctx) {
  if (!needs) return true;
  return Object.entries(needs).every(([key, value]) => {
    const predicate = PREDICATES[key];
    if (!predicate) return false;   // unknown condition never fires, rather than always firing
    return predicate(value, ctx ?? {});
  });
}

function bool(expected, actual) {
  return Boolean(actual) === Boolean(expected);
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function matchesAny(expected, actual) {
  if (actual == null) return false;
  return (Array.isArray(expected) ? expected : [expected]).includes(actual);
}
