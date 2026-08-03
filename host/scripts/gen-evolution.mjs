#!/usr/bin/env node
// Build seed/evolution/_generated.json: the canonical Gen-1 evolution table.
//
//   cd host && node scripts/gen-evolution.mjs          # write the file
//   cd host && node scripts/gen-evolution.mjs --dry    # print the survey only
//
// Why this exists: `seed/evolution/` held four hand-authored lines -- the three
// starters and eevee -- and `evolution.js` returns no branches at all for a
// species with no entry. So 63 of the 70 species that can evolve simply never
// did, silently. The owner hit it from the other end on 2026-08-03: his buddy
// reached the level its species evolves at and nothing happened.
//
// Same rule as `gen-wild-rarity.mjs`, and for the same reason: the numbers come
// from canonical data, not from anyone's judgement.
//
// ## What is in scope
//
// A link is generated when BOTH ends are among the 151 and the trigger is one
// Generation 1 actually had:
//
//   level-up with a min_level  ->  { "level": N }
//   use-item, Gen-1 stone      ->  { "stone": "fire" | "water" | "thunder" | "leaf" | "moon" }
//
// Everything else is dropped, because PokeAPI reports each link the way the
// LATEST generation implements it, not the way Gen 1 did. That is not a detail:
// it serves ice-stone and galarica-cuff links for species that are in the 151,
// and a happiness link, none of which are mechanics this project has. Taking
// PokeAPI's answer literally would have quietly imported three later-generation
// systems into a Gen-1 game.
//
// Trade links are in scope as *species* and out of scope as *mechanics* -- this
// device has nothing to trade with. They are handled by a separate generator,
// deliberately not this one, and how is not discussed here.
//
// ## What is preserved
//
// The four hand-authored files are never touched and never regenerated. eevee's
// especially: its conditions (bond, daytime, warmHumid, care) are this project's
// own adaptation and reach five species that are not in the 151 at all. This
// script asserts it emits no key that a hand-authored file already defines --
// `evolution.js` merges the directory with Object.assign, so a collision would
// resolve by readdir order, which is not a decision anyone would have made.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEX_MAX = 151;
const CACHE = fileURLToPath(new URL("../out/pokeapi-cache/", import.meta.url));
const DIR = fileURLToPath(new URL("../seed/evolution/", import.meta.url));
const OUT = `${DIR}_generated.json`;
const POKEDEX = fileURLToPath(new URL("../seed/pokedex.json", import.meta.url));

// The five stones Generation 1 shipped. `ice-stone` (gen 8 for these species)
// and `galarica-cuff` (gen 8) are the ones this set exists to exclude.
const GEN1_STONES = new Map([
  ["fire-stone", "fire"],
  ["water-stone", "water"],
  ["thunder-stone", "thunder"],
  ["leaf-stone", "leaf"],
  ["moon-stone", "moon"],
]);

// Matches eevee.json, which is the only prior art: a level/bond branch outranks
// a stone branch, so a line offering both auto-evolves on the one you grow into
// and keeps the stone as the deliberate act.
const PRIORITY_LEVEL = 1;
const PRIORITY_STONE = 9;

const dry = process.argv.includes("--dry");

mkdirSync(CACHE, { recursive: true });

async function get(url) {
  const file = `${CACHE}${url.replace(/[^a-z0-9]+/gi, "_")}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const res = await fetch(url, { headers: { "user-agent": "claude-pokemon-buddy evolution baker" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const body = await res.json();
  writeFileSync(file, JSON.stringify(body));
  return body;
}

const pokedex = JSON.parse(readFileSync(POKEDEX, "utf8"));
const inDex = new Set(pokedex.species.map((s) => s.key));

// Whatever the hand-authored files already define, keyed by the species they
// define -- not by filename. A generated entry for any of these would be a
// silent overwrite of the owner's own data.
const handAuthored = new Set();
for (const file of readdirSync(DIR)) {
  if (!file.endsWith(".json") || file.startsWith("_")) continue;
  for (const key of Object.keys(JSON.parse(readFileSync(`${DIR}${file}`, "utf8")))) handAuthored.add(key);
}

const chains = new Set();
for (const species of pokedex.species) {
  chains.add((await get(`https://pokeapi.co/api/v2/pokemon-species/${species.dex}/`)).evolution_chain.url);
}

const links = [];
for (const url of chains) {
  (function walk(node, depth) {
    for (const child of node.evolves_to) {
      for (const detail of child.evolution_details) {
        links.push({
          from: node.species.name,
          to: child.species.name,
          stage: depth,
          trigger: detail.trigger?.name,
          minLevel: detail.min_level,
          item: detail.item?.name ?? null,
        });
      }
      walk(child, depth + 1);
    }
  })((await get(url)).chain, 0);
}

const inScope = links.filter((l) => inDex.has(l.from) && inDex.has(l.to));

const table = {};
const stageOf = new Map();
const dropped = { trigger: 0, item: 0, noLevel: 0, handAuthored: 0 };

for (const link of inScope) {
  if (handAuthored.has(link.from)) { dropped.handAuthored++; continue; }

  let needs = null;
  if (link.trigger === "level-up") {
    if (typeof link.minLevel === "number" && link.minLevel > 0) needs = { level: link.minLevel };
    else { dropped.noLevel++; continue; }
  } else if (link.trigger === "use-item") {
    const stone = GEN1_STONES.get(link.item);
    if (stone) needs = { stone };
    else { dropped.item++; continue; }
  } else {
    dropped.trigger++;                 // trade, and anything later generations added
    continue;
  }

  stageOf.set(link.from, link.stage);
  stageOf.set(link.to, link.stage + 1);
  table[link.from] ??= { stage: link.stage, branches: [] };
  table[link.from].branches.push({
    to: link.to,
    needs,
    priority: needs.stone ? PRIORITY_STONE : PRIORITY_LEVEL,
  });
}

// Terminal forms need an entry too. Without one `eligibleBranches` returns []
// for them, which is the right ANSWER but arrives by the same route as "this
// species is missing from the table" -- and that ambiguity is exactly what took
// a day to notice. An explicit empty `branches` says it was considered.
for (const [species, stage] of stageOf) {
  if (!table[species] && !handAuthored.has(species)) table[species] = { stage, branches: [] };
}

for (const node of Object.values(table)) {
  node.branches.sort((a, b) => a.priority - b.priority || a.to.localeCompare(b.to));
}

const collisions = Object.keys(table).filter((key) => handAuthored.has(key));
if (collisions.length) throw new Error(`generated entries collide with hand-authored files: ${collisions.join(", ")}`);

const sorted = Object.fromEntries(Object.entries(table).sort((a, b) => a[0].localeCompare(b[0])));

// Counts only. The owner reads this output, and while canonical evolution levels
// are not secret, which species end up reachable how is adjacent to the wild
// pool -- and the trade substitutions are a deliberate surprise (CLAUDE.md).
console.log(`chains fetched         : ${chains.size}`);
console.log(`links, both ends Gen-1 : ${inScope.length}`);
console.log(`  dropped, hand-authored: ${dropped.handAuthored}`);
console.log(`  dropped, non-Gen-1 trigger: ${dropped.trigger}`);
console.log(`  dropped, non-Gen-1 item   : ${dropped.item}`);
console.log(`  dropped, level-up with no level: ${dropped.noLevel}`);
console.log(`species with branches  : ${Object.values(sorted).filter((n) => n.branches.length).length}`);
console.log(`terminal forms recorded: ${Object.values(sorted).filter((n) => !n.branches.length).length}`);
console.log(`entries written        : ${Object.keys(sorted).length}`);

if (dry) { console.log("(--dry, nothing written)"); process.exit(0); }
writeFileSync(OUT, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`wrote ${OUT}`);
