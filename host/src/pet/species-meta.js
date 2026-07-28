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

export function dexNumber(species) {
  return SPECIES_DEX[species] ?? null;
}

export function isDexSpecies(species) {
  return species in SPECIES_DEX;
}

export function speciesTypes(species) {
  return TYPES[species] ?? LEGACY_TYPES[species] ?? [];
}
