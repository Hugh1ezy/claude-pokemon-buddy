// One-shot generator: pull everything the buddy needs to know about the first
// 151 species from PokeAPI and write it to seed/pokedex.json.
//
// Run from host/: node scripts/gen-pokedex.mjs
//
// What lands in the file is metadata only -- names, types, evolution rules,
// and the game's own rarity numbers. No artwork and no audio: those are baked
// by scripts/bake-assets.mjs into files this repo deliberately does not carry
// (see seed/.gitignore). This one IS committed, so a normal checkout needs no
// network to build a pokedex, and a re-run is diffable against what shipped.
//
// The evolution rules are recorded as PokeAPI states them, not as this project
// consumes them -- converting to seed/evolution/*.json is a separate step, and
// keeping the raw form means a wrong conversion can be re-done without
// re-fetching 300 URLs.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API = "https://pokeapi.co/api/v2";
const DEX_MAX = 151;
const CONCURRENCY = 8;
const OUT = fileURLToPath(new URL("../seed/pokedex.json", import.meta.url));

async function getJson(url, attempt = 1) {
  const res = await fetch(url, { headers: { "user-agent": "claude-pokemon-buddy pokedex generator" } });
  if (res.ok) return res.json();
  // PokeAPI is a public free service; a 429/5xx is worth one polite retry
  // rather than throwing away the 150 requests that already succeeded.
  if (attempt <= 3 && (res.status === 429 || res.status >= 500)) {
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    return getJson(url, attempt + 1);
  }
  throw new Error(`fetch failed ${res.status} ${url}`);
}

// Bounded fan-out. 151 species x 2 endpoints in one go gets rate-limited; a
// plain sequential loop takes minutes. Eight at a time does it in seconds and
// has never been throttled in practice.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// Owner's preference, 2026-07-29: twenty species go by their pre-unification
// Chinese names rather than the ones PokeAPI now returns. These are the names
// he grew up with, and the buddy is his, so they win over the official list.
//
// This lives here rather than as a hand-edit of seed/pokedex.json precisely so
// a re-run of this generator does not silently revert them -- which is what
// would have happened, since PokeAPI is the only other source of the field.
// Keyed by species key (stable) rather than dex number (also stable, but the
// key is what every other table in the project joins on).
const OLD_ZH = {
  butterfree: "巴大蝴", pidgeot: "比雕", venomoth: "末入蛾",
  poliwhirl: "蚊香蛙", poliwrath: "快泳蛙", kadabra: "勇吉拉",
  slowbro: "呆河马", drowzee: "素利普", hypno: "素利柏",
  voltorb: "雷电球", electrode: "顽皮弹", hitmonlee: "沙瓦郎",
  hitmonchan: "艾比郎", rhyhorn: "铁甲犀牛", rhydon: "铁甲暴龙",
  kangaskhan: "袋龙", magmar: "鸭嘴火龙", pinsir: "大甲",
  lapras: "乘龙", porygon: "3D龙",
};

function zhName(species) {
  if (species.name in OLD_ZH) return OLD_ZH[species.name];
  // zh-Hans is what the panel renders (Zpix is a simplified-Chinese pixel
  // font). zh-Hant is the fallback purely so a missing entry surfaces as the
  // wrong script rather than as an English name in the middle of a Chinese UI.
  // PokeAPI spells these lowercase ("zh-hans", not the BCP-47-cased
  // "zh-Hans"), and an exact-case match silently falls through to the English
  // key for all 151 -- which looks like a working generator until you read the
  // output. Normalising the case is what makes the mismatch impossible.
  const names = species.names ?? [];
  const byLang = (code) => names.find((n) => (n.language?.name ?? "").toLowerCase() === code);
  return byLang("zh-hans")?.name ?? byLang("zh-hant")?.name ?? species.name;
}

// PokeAPI models an evolution chain as a tree of "this species, and what it
// can become". Flatten it to one entry per transition, keeping every condition
// the game attaches -- level, item, held item, time of day, happiness, trade,
// location, stats. Which of these the device can actually observe is decided
// later; throwing them away here would mean re-fetching to change that mind.
function flattenChain(node, into = []) {
  for (const next of node.evolves_to ?? []) {
    for (const detail of next.evolution_details ?? []) {
      into.push({
        from: node.species.name,
        to: next.species.name,
        trigger: detail.trigger?.name ?? null,
        minLevel: detail.min_level ?? null,
        item: detail.item?.name ?? null,
        heldItem: detail.held_item?.name ?? null,
        timeOfDay: detail.time_of_day || null,
        minHappiness: detail.min_happiness ?? null,
        minBeauty: detail.min_beauty ?? null,
        minAffection: detail.min_affection ?? null,
        needsRain: detail.needs_overworld_rain ?? false,
        location: detail.location?.name ?? null,
        knownMove: detail.known_move?.name ?? null,
        knownMoveType: detail.known_move_type?.name ?? null,
        partySpecies: detail.party_species?.name ?? null,
        tradeSpecies: detail.trade_species?.name ?? null,
        gender: detail.gender ?? null,
        relativePhysicalStats: detail.relative_physical_stats ?? null,
        turnUpsideDown: detail.turn_upside_down ?? false,
      });
    }
    flattenChain(next, into);
  }
  return into;
}

const ids = Array.from({ length: DEX_MAX }, (_, i) => i + 1);

console.log(`fetching ${DEX_MAX} species + forms from ${API} ...`);
const entries = await mapLimit(ids, CONCURRENCY, async (dex) => {
  const [species, form] = await Promise.all([
    getJson(`${API}/pokemon-species/${dex}`),
    getJson(`${API}/pokemon/${dex}`),
  ]);
  return {
    dex,
    key: species.name,
    zh: zhName(species),
    types: form.types.sort((a, b) => a.slot - b.slot).map((t) => t.type.name),
    // captureRate is the game's own 0-255 rarity dial (higher = easier). It is
    // the single most useful number here: encounter design gets to lean on
    // Game Freak's own answer to "how common is this" instead of a hand-made
    // tier list. baseHappiness/growthRate/hatchCounter are the matching dials
    // for how fast a species warms to you.
    captureRate: species.capture_rate,
    baseHappiness: species.base_happiness,
    growthRate: species.growth_rate?.name ?? null,
    hatchCounter: species.hatch_counter,
    isLegendary: species.is_legendary,
    isMythical: species.is_mythical,
    isBaby: species.is_baby,
    habitat: species.habitat?.name ?? null,
    color: species.color?.name ?? null,
    genderRate: species.gender_rate,
    evolutionChainUrl: species.evolution_chain?.url ?? null,
    evolvesFrom: species.evolves_from_species?.name ?? null,
  };
});

// Chains are shared between every member of a family, so fetch each one once.
const chainUrls = [...new Set(entries.map((e) => e.evolutionChainUrl).filter(Boolean))];
console.log(`fetching ${chainUrls.length} evolution chains ...`);
const chains = await mapLimit(chainUrls, CONCURRENCY, (url) => getJson(url));

const withinDex = new Set(entries.map((e) => e.key));
const evolutions = [];
const droppedOutOfDex = [];
for (const chain of chains) {
  for (const link of flattenChain(chain.chain)) {
    // Gen-1 species with later-generation evolutions (Golbat->Crobat,
    // Eevee->Espeon, Onix->Steelix, ...) come back in these chains. The dex is
    // 1-151 and the denominator stays 151, so those targets are recorded
    // separately rather than silently kept or silently dropped -- the list is
    // worth reading before deciding what a species can become here.
    if (withinDex.has(link.from) && withinDex.has(link.to)) evolutions.push(link);
    else droppedOutOfDex.push(link);
  }
}

const out = {
  _doc: "Generated by host/scripts/gen-pokedex.mjs from pokeapi.co. Metadata only -- no artwork, no audio. Regenerate: cd host && node scripts/gen-pokedex.mjs",
  source: API,
  dexMax: DEX_MAX,
  species: entries.map(({ evolutionChainUrl, ...rest }) => rest),
  evolutions,
  outOfDexEvolutions: droppedOutOfDex,
};

mkdirSync(fileURLToPath(new URL("../seed/", import.meta.url)), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote seed/pokedex.json: ${out.species.length} species, ${evolutions.length} in-dex evolutions, ${droppedOutOfDex.length} out-of-dex`);
