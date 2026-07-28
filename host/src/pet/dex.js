// Pokedex + box: what has been caught, how many times, and which pets are
// being kept. Pure data and pure functions -- no file I/O, no rendering. The
// save layer (state.js) validates these fields; the capture flow calls
// recordCapture(); the pokedex screen reads dexProgress()/dexEntries().
//
// Deliberately additive to the existing save, and deliberately NOT a schema
// version bump. loadState() accepts a save only on an exact schemaVersion
// match and otherwise falls back to a whitelist salvage that drops everything
// it does not recognise. A bump would therefore make the OTHER machine -- any
// machine still running older code -- read this machine's save, silently strip
// the dex and the box, and push the stripped copy back through save-sync. The
// dex would be gone with no error anywhere. Left at version 1, the old code
// takes its normal path, which copies the state object wholesale and only
// touches keys it knows: the new fields ride through untouched.
//
// The three quantities the panel shows are NOT interchangeable:
//   capturedCount  every capture ever, duplicates included      (the "a" line)
//   dexCaught      distinct species caught, i.e. pokedex完成度   (the "b" line)
//   box            the pets actually being kept, one per species
// Catching a second Pidgey moves the first number and nothing else: the first
// Pidgey's save is the only Pidgey save there will ever be.

import { DEX_MAX, SPECIES_ORDER, isDexSpecies } from "./species-meta.js";

export const BOX_MAX = DEX_MAX;

export function emptyDex() {
  return { dexCaught: [], capturedCount: 0, box: [] };
}

// Normalise whatever came off disk into something the rest of the code can
// trust: sorted, unique, in-dex, and consistent with each other. Anything
// unrecognisable is dropped rather than repaired into a plausible-looking
// wrong answer -- a dex entry for a species that does not exist would render
// as a blank row forever with nothing to explain it.
export function normalizeDex(raw) {
  const dexCaught = [...new Set(
    (Array.isArray(raw?.dexCaught) ? raw.dexCaught : []).filter((key) => typeof key === "string" && isDexSpecies(key)),
  )].sort(byDexOrder);

  const box = [];
  const seenInBox = new Set();
  for (const entry of Array.isArray(raw?.box) ? raw.box : []) {
    const species = entry?.species;
    if (typeof species !== "string" || seenInBox.has(species)) continue;  // one per species, first wins
    if (!isDexSpecies(species) && !entry?.legacy) continue;
    seenInBox.add(species);
    box.push(entry);
  }

  // capturedCount counts duplicates, so it can exceed the number of distinct
  // species -- but it can never be BELOW it, and a save claiming otherwise is
  // repaired upward rather than trusted. (Hand-edited saves and interrupted
  // writes both produce this; the alternative is a panel reading "已捕获 3 只 ·
  // 图鉴 7/151", which is nonsense on its face.)
  const claimed = Number(raw?.capturedCount);
  const capturedCount = Number.isInteger(claimed) && claimed >= 0
    ? Math.max(claimed, dexCaught.length)
    : dexCaught.length;

  return { dexCaught, capturedCount, box };
}

// A capture. Returns a new dex state plus what actually changed, so the caller
// can decide what to say on screen ("新的宝可梦！" vs "又一只波波").
export function recordCapture(dex, pet) {
  const species = pet?.species;
  if (typeof species !== "string" || !isDexSpecies(species)) {
    throw new Error(`recordCapture: not a dex species: ${species}`);
  }

  const current = normalizeDex(dex);
  const isNewToDex = !current.dexCaught.includes(species);
  const isNewToBox = !current.box.some((entry) => entry.species === species);
  // Box full only blocks keeping the pet; the dex entry and the tally still
  // count. Meeting a species is not undone by having nowhere to put it.
  const canKeep = isNewToBox && current.box.length < BOX_MAX;

  return {
    dex: {
      dexCaught: isNewToDex ? [...current.dexCaught, species].sort(byDexOrder) : current.dexCaught,
      capturedCount: current.capturedCount + 1,
      box: canKeep ? [...current.box, pet] : current.box,
    },
    isNewToDex,
    keptInBox: canKeep,
    // True when this species is already in the box: the existing one is left
    // exactly as it is, levels and all. This is the duplicate rule, and the
    // flag exists so the screen can say so rather than looking like a no-op.
    duplicate: !isNewToBox,
  };
}

// Owning a species without catching one: the starter that hatched from the
// egg, and every form it evolves into. Unlocks the pokedex entry and nothing
// else -- capturedCount counts captures, and neither of these is one, nor does
// the box get a second copy of the pet already sitting on the panel.
//
// Without this the starter line is unobtainable: it is deliberately excluded
// from wild encounters (you already have one), so the only way those entries
// can ever light up is here. A year-long simulation stalled three entries
// short of 151 for exactly this reason before it existed.
export function recordSeen(dex, species) {
  const current = normalizeDex(dex);
  if (!isDexSpecies(species) || current.dexCaught.includes(species)) return current;
  return { ...current, dexCaught: [...current.dexCaught, species].sort(byDexOrder) };
}

export function dexProgress(dex) {
  const current = normalizeDex(dex);
  return {
    capturedCount: current.capturedCount,   // a: 已捕获 (含重复)
    dexCaught: current.dexCaught.length,    // b: 图鉴完成数 (不含重复)
    dexTotal: DEX_MAX,
    boxCount: current.box.length,
  };
}

// The full 151 rows the pokedex screen draws, in dex order. `caught: false`
// rows are the black silhouettes -- listed, numbered, and not selectable.
export function dexEntries(dex) {
  const caught = new Set(normalizeDex(dex).dexCaught);
  return SPECIES_ORDER.map((species, index) => ({
    dex: index + 1,
    species,
    caught: caught.has(species),
  }));
}

export function boxPet(dex, species) {
  return normalizeDex(dex).box.find((entry) => entry.species === species) ?? null;
}

const DEX_INDEX = new Map(SPECIES_ORDER.map((key, i) => [key, i]));

function byDexOrder(a, b) {
  return (DEX_INDEX.get(a) ?? Infinity) - (DEX_INDEX.get(b) ?? Infinity);
}
