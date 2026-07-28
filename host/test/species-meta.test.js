import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEX_MAX,
  SPECIES_DEX,
  SPECIES_ORDER,
  SPECIES_ZH,
  dexNumber,
  isDexSpecies,
  speciesTypes,
  zhName,
} from "../src/pet/species-meta.js";

// The five later-generation Eeveelutions an existing save can still be on.
// Nameable and drawable, but deliberately not dex entries.
const LEGACY = ["espeon", "umbreon", "leafeon", "glaceon", "sylveon"];

test("the dex is exactly 1..151, in order, with no gaps or repeats", () => {
  assert.equal(DEX_MAX, 151);
  assert.equal(SPECIES_ORDER.length, 151);
  assert.deepEqual(
    SPECIES_ORDER.map((key) => SPECIES_DEX[key]),
    Array.from({ length: 151 }, (_, i) => i + 1),
  );
  assert.equal(new Set(SPECIES_ORDER).size, 151);
});

test("every dex species has a Chinese name, and none leaked through as its English key", () => {
  const untranslated = SPECIES_ORDER.filter((key) => !/[一-鿿]/.test(SPECIES_ZH[key] ?? ""));
  // A missing zh name throws nowhere -- zhName falls back to the raw key, so
  // the panel would quietly render "bulbasaur" and nothing would complain.
  // This is the only thing that would catch it, and it has already happened
  // once: PokeAPI spells the language "zh-hans", and a case-sensitive match
  // returned English for all 151 while looking like a working generator.
  assert.deepEqual(untranslated, [], `untranslated: ${untranslated.join(", ")}`);
});

test("every dex species has at least one type", () => {
  const typeless = SPECIES_ORDER.filter((key) => speciesTypes(key).length === 0);
  assert.deepEqual(typeless, []);
});

test("legacy Eeveelutions are nameable and typed but are not dex entries", () => {
  for (const key of LEGACY) {
    assert.match(SPECIES_ZH[key] ?? "", /[一-鿿]/, `${key} needs a Chinese name`);
    assert.ok(speciesTypes(key).length > 0, `${key} needs a type`);
    assert.equal(isDexSpecies(key), false, `${key} must not count toward the dex`);
    assert.equal(dexNumber(key), null);
    assert.ok(!SPECIES_ORDER.includes(key));
  }
});

test("spot-check names and dex numbers against the real games", () => {
  assert.equal(zhName("bulbasaur"), "妙蛙种子");
  assert.equal(zhName("eevee"), "伊布");
  assert.equal(zhName("pikachu"), "皮卡丘");
  assert.equal(zhName("gastly"), "鬼斯");
  assert.equal(zhName("mewtwo"), "超梦");
  assert.equal(zhName("mew"), "梦幻");
  assert.equal(dexNumber("bulbasaur"), 1);
  assert.equal(dexNumber("pikachu"), 25);
  assert.equal(dexNumber("mew"), 151);
});

test("zhName falls back to the raw species id for unknown", () => {
  assert.equal(zhName("missingno"), "missingno");
  assert.equal(dexNumber("missingno"), null);
  assert.equal(isDexSpecies("missingno"), false);
  assert.deepEqual(speciesTypes("missingno"), []);
});
