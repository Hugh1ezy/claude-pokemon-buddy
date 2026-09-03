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
//
// Everything else is dropped, because PokeAPI reports each link the way the
// LATEST generation implements it, not the way Gen 1 did. That is not a detail:
// it serves ice-stone and galarica-cuff links for species that are in the 151,
// and a happiness link, none of which are mechanics this project has. Taking
// PokeAPI's answer literally would have quietly imported three later-generation
// systems into a Gen-1 game.
//
// ## Item and trade links leave here as an inventory, not as branches
//
// Trade links were always in scope as *species* and out of scope as *mechanics*
// -- this device has nothing to trade with. As of 2026-09-04 the owner extended
// that ruling to every link that needs an ITEM: there are no stones here either,
// and he asked for each one to be given a substitute condition designed without
// him, the same way the trade links already were.
//
// So this script no longer emits a `stone` branch. It writes the canonical
// item/trade links to `seed/evolution-item-links.json` -- an inventory of what
// Gen 1 required, which is public knowledge and says nothing about what this
// game asks instead -- and a separate generator turns each entry into a branch.
// Which conditions those are is not discussed here, in any commit message, or
// in any file outside the ones the repo marks as spoilers.
//
// The inventory is deliberately OUTSIDE `seed/evolution/`: `evolution.js` loads
// every .json in that directory as a table, and this is not one.
//
// Hand-authored species are skipped for the TABLE and still surveyed for the
// INVENTORY. eevee is the only one that contributes, and leaving it out would
// have meant the coverage check downstream could not see its item links at all.
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
const ITEM_LINKS_OUT = fileURLToPath(new URL("../seed/evolution-item-links.json", import.meta.url));
const POKEDEX = fileURLToPath(new URL("../seed/pokedex.json", import.meta.url));

// The five stones Generation 1 shipped. `ice-stone` (gen 8 for these species)
// and `galarica-cuff` (gen 8) are the ones this set exists to exclude: an item
// this game substitutes for has to be one Generation 1 actually asked for.
const GEN1_STONES = new Map([
  ["fire-stone", "fire"],
  ["water-stone", "water"],
  ["thunder-stone", "thunder"],
  ["leaf-stone", "leaf"],
  ["moon-stone", "moon"],
]);

const PRIORITY_LEVEL = 1;

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
const itemLinks = [];
const dropped = { trigger: 0, item: 0, noLevel: 0, handAuthored: 0 };

for (const link of inScope) {
  // Surveyed BEFORE the hand-authored skip, so eevee's item links reach the
  // inventory. Nothing in this block can reach the table.
  const stone = link.trigger === "use-item" ? GEN1_STONES.get(link.item) ?? null : null;
  if (stone || link.trigger === "trade") {
    itemLinks.push({
      from: link.from,
      to: link.to,
      stage: link.stage,
      requires: stone ? `${stone}-stone` : "trade",
    });
  }

  if (handAuthored.has(link.from)) { dropped.handAuthored++; continue; }

  if (link.trigger !== "level-up") {
    // trade, use-item, and whatever later generations added. The first two are
    // in the inventory above and become branches in a different generator.
    if (link.trigger === "use-item") dropped.item += 1;
    else dropped.trigger += 1;
    continue;
  }
  if (typeof link.minLevel !== "number" || link.minLevel <= 0) { dropped.noLevel++; continue; }

  stageOf.set(link.from, link.stage);
  stageOf.set(link.to, link.stage + 1);
  table[link.from] ??= { stage: link.stage, branches: [] };
  table[link.from].branches.push({ to: link.to, needs: { level: link.minLevel }, priority: PRIORITY_LEVEL });
}

// Deduped: PokeAPI serves one link per generation that implemented it, so the
// same pair can arrive more than once (growlithe -> arcanine arrives twice, and
// that duplicate reached _generated.json unnoticed until 2026-09-04).
const itemLinkKey = (link) => `${link.from}>${link.to}>${link.requires}`;
const uniqueItemLinks = [...new Map(itemLinks.map((link) => [itemLinkKey(link), link])).values()]
  // A pair the table already reaches BY LEVEL is a pair Generation 1 evolved by
  // levelling; the item link PokeAPI also reports for it belongs to a later
  // generation's regional form. Substituting for it would hand one species two
  // roads to the same place for no reason anyone chose -- and would quietly
  // import exactly the later-generation mechanic the scope rule exists to keep
  // out. Same family of mistake as ice-stone and galarica-cuff, arriving from
  // the other direction.
  .filter((link) => !(table[link.from]?.branches ?? []).some((b) => b.to === link.to && b.needs.level != null))
  .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

// Terminal forms need an entry too. Without one `eligibleBranches` returns []
// for them, which is the right ANSWER but arrives by the same route as "this
// species is missing from the table" -- and that ambiguity is exactly what took
// a day to notice. An explicit empty `branches` says it was considered.
for (const [species, stage] of stageOf) {
  if (!table[species] && !handAuthored.has(species)) table[species] = { stage, branches: [] };
}

// Deduped for the same reason the inventory is: PokeAPI repeats a link once per
// generation that implemented it, so seven identical level branches were being
// written out. `evolution.js` collapses them at load time now, but a table that
// says a thing twice is a table nobody can diff.
for (const node of Object.values(table)) {
  const seen = new Set();
  node.branches = node.branches.filter((branch) => {
    const key = `${branch.to}>${JSON.stringify(branch.needs)}>${branch.priority}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
console.log(`  dropped, non-level trigger: ${dropped.trigger}`);
console.log(`  dropped, item-triggered   : ${dropped.item}`);
console.log(`item/trade links inventoried: ${uniqueItemLinks.length}`);
console.log(`  dropped, level-up with no level: ${dropped.noLevel}`);
console.log(`species with branches  : ${Object.values(sorted).filter((n) => n.branches.length).length}`);
console.log(`terminal forms recorded: ${Object.values(sorted).filter((n) => !n.branches.length).length}`);
console.log(`entries written        : ${Object.keys(sorted).length}`);

if (dry) { console.log("(--dry, nothing written)"); process.exit(0); }
writeFileSync(OUT, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`wrote ${OUT}`);
writeFileSync(ITEM_LINKS_OUT, `${JSON.stringify(uniqueItemLinks, null, 2)}\n`);
console.log(`wrote ${ITEM_LINKS_OUT}`);
