// Build seed/wild-rarity.json: how available each of the 151 actually is in the
// wild in Generation 1, straight from PokeAPI.
//
//   cd host && node scripts/gen-wild-rarity.mjs
//
// Why this exists: the encounter table's weights were originally picked by hand,
// and that produced a stage-2 pokemon turning up as casually as a stage-1 one --
// which is not how the games behave. The owner's instruction (2026-07-30) was
// explicitly "don't guess, the numbers are on the pokemon sites". So the weights
// now derive from canonical data rather than from anyone's judgement.
//
// What is recorded per species, and deliberately nothing more -- this file holds
// FACTS ABOUT THE REAL GAMES, not decisions about ours. It is not a spoiler: it
// says nothing about which species this project surfaces under which conditions.
// The mapping stays where it always was.
//
//   areas       how many Gen-1 location areas it can be met in at all
//   chanceSum   sum of its encounter chances across those areas -- the honest
//               measure of "how much of the wild is this pokemon", since a
//               species on 18 routes at 20% is far more present than one on 3
//               routes at 5% even though both "appear in the wild"
//   chanceMax   its best single-area rate
//   methods     walk / surf / fishing / etc, so the caller can decide which of
//               them a buddy on a walk should be able to meet
//   captureRate canonical catch rate, 3 (hardest) .. 255 (easiest)
//   stage       0 = base form, 1 = first evolution, 2 = second
//   evolvesFrom the species it comes from, or null
//   legendary   is_legendary || is_mythical
//
// PokeAPI is called ~302 times, so responses are cached under out/pokeapi-cache/
// and a re-run costs nothing. Delete that directory to force a refetch.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEX_MAX = 151;
const GEN1 = new Set(["red", "blue", "yellow"]);
// A buddy out for a walk meets what you meet on foot. Fishing, surfing, gift,
// trade and static entries are still recorded in `methods`, but they must not
// count as wild presence: treating a trade-only species as findable is how
// something the games never put in the grass ends up in the grass here.
const WALK_LIKE = new Set(["walk"]);
const CACHE = fileURLToPath(new URL("../out/pokeapi-cache/", import.meta.url));
const OUT = fileURLToPath(new URL("../seed/wild-rarity.json", import.meta.url));

mkdirSync(CACHE, { recursive: true });

async function get(url) {
  const file = `${CACHE}${url.replace(/[^a-z0-9]+/gi, "_")}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const body = await res.json();
  writeFileSync(file, JSON.stringify(body));
  return body;
}

// Depth in its own evolution line. Walked from the species rather than from the
// chain object because `evolves_from_species` is the only field that is reliably
// present for every one of the 151.
async function stageOf(species) {
  let depth = 0;
  let cur = species;
  while (cur.evolves_from_species) {
    depth += 1;
    cur = await get(cur.evolves_from_species.url);
    if (depth > 4) break;   // no Gen-1 line is deeper than 2; guard a cycle
  }
  return depth;
}

async function main() {
  const out = [];
  for (let id = 1; id <= DEX_MAX; id++) {
    const species = await get(`https://pokeapi.co/api/v2/pokemon-species/${id}/`);
    const encounters = await get(`https://pokeapi.co/api/v2/pokemon/${id}/encounters`);

    let areas = 0;
    let chanceSum = 0;
    let chanceMax = 0;
    let walkAreas = 0;
    let walkChanceSum = 0;
    const methods = new Set();
    for (const area of encounters) {
      // One area can list the same species under several Gen-1 versions and
      // several methods. The area counts once, and its contribution is the BEST
      // single rate offered there -- summing every version's copy of the same
      // encounter would triple-count anything present in red, blue and yellow.
      let best = 0;
      let walkBest = 0;
      for (const vd of area.version_details) {
        if (!GEN1.has(vd.version.name)) continue;
        for (const ed of vd.encounter_details) {
          methods.add(ed.method.name);
          best = Math.max(best, ed.chance);
          if (WALK_LIKE.has(ed.method.name)) walkBest = Math.max(walkBest, ed.chance);
        }
      }
      if (best > 0) { areas += 1; chanceSum += best; chanceMax = Math.max(chanceMax, best); }
      if (walkBest > 0) { walkAreas += 1; walkChanceSum += walkBest; }
    }

    out.push({
      key: species.name,
      dex: id,
      areas,
      chanceSum,
      chanceMax,
      walkAreas,
      walkChanceSum,
      methods: [...methods].sort(),
      captureRate: species.capture_rate,
      stage: await stageOf(species),
      evolvesFrom: species.evolves_from_species?.name ?? null,
      legendary: Boolean(species.is_legendary || species.is_mythical),
    });
    if (id % 25 === 0) console.log(`  ${id}/${DEX_MAX}`);
  }

  writeFileSync(OUT, `${JSON.stringify({ source: "pokeapi, generation i (red/blue/yellow)", species: out }, null, 2)}\n`);

  // Aggregates only. Naming which species sit in which bucket would be a step
  // towards the thing the owner asked never to be told.
  const byStage = [0, 1, 2].map((s) => out.filter((e) => e.stage === s));
  console.log(`\nwrote seed/wild-rarity.json (${out.length} species)`);
  for (const [i, group] of byStage.entries()) {
    const wild = group.filter((e) => e.areas > 0);
    const mean = wild.length ? (wild.reduce((t, e) => t + e.chanceSum, 0) / wild.length).toFixed(1) : "0";
    console.log(`  stage ${i}: ${group.length} species, ${wild.length} appear wild, mean chanceSum ${mean}`);
  }
  const never = out.filter((e) => e.areas === 0);
  console.log(`  never wild in gen 1: ${never.length} species (${never.filter((e) => e.legendary).length} legendary/mythical)`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
