import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Chinese names, single-sourced from seed/pokedex.json (scripts/gen-pokedex.mjs)
// rather than a hand-kept list: 151 entries typed out by hand is 151 chances to
// put the wrong name on the panel, and nothing downstream would catch it.
const pokedex = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../seed/pokedex.json", import.meta.url)), "utf8"),
);

// Not dex entries. These five Eeveelutions arrived in later generations, but
// seed/evolution/eevee.json can still reach them, so a buddy can still BE one
// and the panel still has to name it. They are deliberately outside
// SPECIES_ORDER and do not count toward DEX_MAX -- the pokedex screen lists
// 151 and these are not among them.
const LEGACY_NON_DEX_ZH = {
  espeon: "太阳伊布",
  umbreon: "月亮伊布",
  leafeon: "叶伊布",
  glaceon: "冰伊布",
  sylveon: "仙子伊布",
};

const DEX_ZH = Object.fromEntries(pokedex.species.map((s) => [s.key, s.zh]));

export const SPECIES_ZH = { ...DEX_ZH, ...LEGACY_NON_DEX_ZH };
export const SPECIES_DEX = Object.fromEntries(pokedex.species.map((s) => [s.key, s.dex]));
// Dex order -- the order the pokedex screen lists them in, and the only list
// that "how complete is the pokedex" may ever be measured against.
export const SPECIES_ORDER = pokedex.species.map((s) => s.key);
export const DEX_MAX = pokedex.dexMax;
// PokeAPI's 3 (hardest) to 255 (easiest). Exposed as a plain lookup so the one
// thing that consumes it -- capture-tuning.js, which is a spoiler file -- can
// stay the only place that knows what it is used FOR.
export const SPECIES_CAPTURE_RATE = Object.fromEntries(
  pokedex.species.map((s) => [s.key, s.captureRate]),
);

const TYPES = Object.fromEntries(pokedex.species.map((s) => [s.key, s.types]));
// Eeveelution typing, for the same reason as the names above. Not from PokeAPI
// because these are not in the fetched range.
const LEGACY_TYPES = {
  espeon: ["psychic"], umbreon: ["dark"], leafeon: ["grass"],
  glaceon: ["ice"], sylveon: ["fairy"],
};

export function zhName(species) {
  return SPECIES_ZH[species] ?? species;
}

// How a pokemon is named anywhere it is shown: the owner's name, 的, and the
// species' pokedex name. Always composed, never read out of the save's `name`
// field -- that one is written once at onboarding from the starter's species
// and never follows an evolution, so it goes stale the first time the buddy
// changes shape. Composing from the CURRENT species is what makes the name and
// the sprite incapable of disagreeing.
export function displayName(ownerName, species) {
  return `${ownerName || "阿布"}的${zhName(species ?? "eevee")}`;
}

export function dexNumber(species) {
  return SPECIES_DEX[species] ?? null;
}

export function isDexSpecies(species) {
  return species in SPECIES_DEX;
}

export function speciesTypes(species) {
  return TYPES[species] ?? LEGACY_TYPES[species] ?? [];
}

const EVOLVES_FROM = Object.fromEntries(
  pokedex.species.filter((s) => s.evolvesFrom).map((s) => [s.key, s.evolvesFrom]),
);
// The five later-generation Eeveelutions are outside pokedex.json, so their
// link back to eevee has to be stated here for the same reason their names and
// types are.
const LEGACY_EVOLVES_FROM = {
  espeon: "eevee", umbreon: "eevee", leafeon: "eevee", glaceon: "eevee", sylveon: "eevee",
};

// The species at the bottom of this one's evolution line -- i.e. what hatched
// from the egg, given what is on the panel now. The save records only the
// CURRENT species, so a buddy that has evolved twice has no other memory of
// what it started as, and "this is not the one you chose" conditions need it.
//
// Walks with a visited set rather than trusting the data to be acyclic: a bad
// generated pokedex would otherwise hang the tick loop rather than fail.
export function evolutionRoot(species) {
  let current = species;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = EVOLVES_FROM[current] ?? LEGACY_EVOLVES_FROM[current];
    if (!parent) break;
    current = parent;
  }
  return current ?? species;
}

// The forward direction, built by inverting the parent links rather than
// re-reading the evolutions table: the table has one row per evolution PATH
// (with all its trigger conditions), and several species have more than one,
// so counting rows would double-count eevee and miss nothing useful here.
const EVOLVES_TO = (() => {
  const out = {};
  for (const [child, parent] of Object.entries({ ...EVOLVES_FROM, ...LEGACY_EVOLVES_FROM })) {
    (out[parent] ??= []).push(child);
  }
  return out;
})();

// Everything this species can still turn into, at any depth. Same visited-set
// discipline as evolutionRoot -- a bad generated pokedex should fail, not hang
// the tick.
export function evolutionDescendants(species) {
  const out = [];
  const seen = new Set([species]);
  const stack = [...(EVOLVES_TO[species] ?? [])];
  while (stack.length) {
    const next = stack.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    stack.push(...(EVOLVES_TO[next] ?? []));
  }
  return out;
}
