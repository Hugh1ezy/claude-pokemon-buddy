#!/usr/bin/env node
// ⚠ SPOILER FILE. Read and edit freely; never let its contents reach the owner.
//
// Build seed/evolution/_special.json -- every Generation 1 evolution that needed
// something this device does not have, given a condition it can actually meet.
//
//   cd host && node scripts/gen-evolution-special.mjs
//
// The owner asked on 2026-08-03 for the trade links to be designed without him:
// 「这是你自己要设计的保密项，不能给我看，是惊喜」. On 2026-09-04 he extended that
// to every ITEM link as well: 「所有依赖道具进化的需要你自己设计新的替代的触发进化
// 的条件，这部分属于保密的神秘内容，即只有你知道，不会让我知道」. So what any of
// these needs is not in any commit message, any doc, any log line or any test
// name -- it lives here and in the JSON this writes, and both are listed as
// spoiler files in CLAUDE.md. Report counts if you must report anything.
//
// The input is seed/evolution-item-links.json, written by gen-evolution.mjs:
// the canonical inventory of which links Gen 1 gated behind a stone or a trade.
// That file is PUBLIC -- it says what Nintendo required, which the owner already
// knows, and nothing about what this game asks instead.
//
// ================================================================= THE DESIGN
//
// A stone and a trade are not the same kind of obstacle, and the substitutes
// should not feel the same either.
//
// A trade meant the one thing a solitary trainer could not do alone: hand the
// pokemon to someone else and get it back changed. There is no second person
// here, so those four ask for something that is not levelling -- sustained care,
// or an hour of the day -- and they sit at the top of the range.
//
// A stone was a PURCHASE. You walked into a department store and bought one. The
// obstacle was never difficulty, it was having thought of it -- so a stone
// substitute must not read as "grind harder than the trade ones". They sit
// BELOW the trade bar, and each of the five stones is stood in for by a single
// idea about the world the device can actually sense:
//
//   fire    -> a bright day          (weatherKind "sun")
//   water   -> rain                  (weatherKind "rain")
//   leaf    -> warm, damp growing air (warmHumid)
//   moon    -> the evening            (night)
//   thunder -> a charge that builds   (streak)
//
// One axis per family, so the five feel like five different things rather than
// five different numbers. And the axis is never the whole answer:
//
// ------------------------------------------------------------------ THE RULES
//
// R1  Every link keeps at least one road that needs NO weather, NO night and NO
//     streak -- only bond, level, and at most `care` or `daytime`. Weather is
//     something that happens to the owner, not something he can arrange, and an
//     evolution he cannot reach by deciding to is an evolution that never comes.
//     The atmospheric branch is always a SHORTCUT at a lower bond, never a gate.
//     (Exception, and only one: a species with several TARGETS -- eevee -- keeps
//     roads that need nothing, and the individual targets are allowed to each
//     want their own weather. Choosing which eeveelution is the feature there.)
//
// R2  `cold` is never used. Measured against the configured coordinates: `cold`
//     is temp <= 4, and this city does not do that outdoors, nor indoors with
//     the device on a desk. eevee's own glaceon branch is already stranded on
//     exactly this and is left alone because it is the owner's own file and his
//     call -- but nothing NEW may be built on it.
//
// R3  Only bond / level / streak / careCount may carry a number. `needsMet`
//     reads every other key as strict equality, so `careCount: 5` would mean
//     EXACTLY five and would be open for one tick in its life. THRESHOLDS in
//     evolution.js is the list; this script asserts against it.
//
// R4  No substitute may point at a target the canonical table already reaches
//     from the same species. Two roads to one place that nobody designed
//     together is how the poliwhirl substitute sat dead in the table from
//     2026-08-03 to 2026-09-04 without a single symptom.
//
// R5  Level floors sit a little above the line's ordinary evolution level, so an
//     item line stays the LAST thing that happens to it rather than the first.
//
// -------------------------------------------------------------- WHAT IT COSTS
//
// bond is the real clock: it rises about four a day the buddy is active, falls
// three a day it is not, and only the pokemon actually on the panel earns any.
// level is cheap by comparison for a buddy in daily use. So the bond floor is
// what a substitute really asks for, and the level floor is there to stop a
// freshly caught level-5 walking straight into its final form on a rainy day.
//
// Trades (unchanged, 2026-08-03):     level 20-36, bond 40-64
// Stones (this pass):                 level 22-36, bond 26-48
//
// ------------------------------------------------------- ONE KNOWN INTERACTION
//
// resolveEvolution auto-picks a priority-1 branch whose needs include
// `care: true` before it considers anything else. On eevee that is sylveon, so
// while careCount > 0 the other seven eeveelutions cannot be chosen. careCount
// decays one per settled day, so a day or two without a long press opens the
// choice again. Pre-existing, deliberate, and left alone -- but it is why the
// three eevee entries below are priority 3 and not priority 1.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../seed/evolution/", import.meta.url));
const GENERATED = `${DIR}_generated.json`;
const ITEM_LINKS = fileURLToPath(new URL("../seed/evolution-item-links.json", import.meta.url));
const OUT = `${DIR}_special.json`;

// Keys `needsMet` compares with >=. Must match THRESHOLDS in src/pet/evolution.js.
const NUMERIC = new Set(["bond", "level", "streak", "careCount"]);
// Keys `evolutionContext` supplies as a state. `cold` is deliberately absent: see R2.
const STATE = new Set(["care", "daytime", "night", "warmHumid", "weatherKind"]);
// Needs that describe something the owner cannot decide to do. R1 counts these.
const UNARRANGEABLE = new Set(["weatherKind", "night", "streak", "warmHumid"]);

// from>to  ->  the roads to it.
//
// Trades first, exactly as they were designed on 2026-08-03. They are not
// re-tuned here: the owner has been playing against these numbers for a month
// and moving them would move a goalpost he cannot see.
//
//   kadabra   the psychic that bends spoons at a distance; it changes when it
//             has been paid enough attention to bother.
//   machoke   the one that trains. it needs the hours AND someone there for them.
//   graveler  rolls downhill and comes back. level and bond, nothing
//             environmental -- it must not depend on weather he cannot arrange.
//   haunter   a ghost, so it gets the one genuinely atmospheric condition in the
//             trade set: at night, with a daytime road at a higher bond so a
//             fortnight of daylight cannot lock it out.
//
// Then the stones, family by family.
//
//   fire / sun
//     growlithe   the loyal dog: it is about being kept, so `care` carries the
//                 main road and the bar is the lowest in the set. It is also the
//                 buddy he is holding on 2026-09-04, and he has been waiting.
//     vulpix      nine tails, one for each century. The slow one of the pair.
//
//   water / rain
//     poliwhirl   keeps the numbers it was given as a trade substitute in August
//                 (it was mis-filed as the fifth trade link, and was dead in the
//                 table besides) and gains a rain road under it.
//     shellder    the one that shuts. `care` to coax it open.
//     staryu      the core that glows: its shortcut wants rain AND the evening.
//
//   leaf / warm damp air
//     gloom       the flower opens in the day.
//     weepinbell  the pitcher: the level-heaviest of the three, no daytime need.
//     exeggcute   a cluster of seeds; the earliest of the three to go.
//
//   moon / evening
//     clefairy    the moon fairy. The evening road is the cheap one.
//     jigglypuff  it sings someone to sleep: `care` on the main road.
//     nidorina    a queen is made by being looked after.
//     nidorino    a king is made by outlasting: the highest level floor of the
//                 four, and no care requirement.
//
//   thunder / a charge that builds
//     pikachu     consecutive days ARE the charge. The only streak road outside
//                 eevee, and it is a shortcut, never the gate.
//
//   eevee (three of eight; see the interaction note above)
//     vaporeon    rain.      jolteon  a long streak.      flareon  a bright day.
//     All at the bond tier the owner's own five already use, so the eight read
//     as one set rather than five of his and three of mine.
const SUBSTITUTES = {
  "kadabra>alakazam": [{ needs: { level: 20, bond: 40, care: true }, priority: 1 }],
  "machoke>machamp": [{ needs: { level: 36, bond: 48, care: true }, priority: 1 }],
  "graveler>golem": [{ needs: { level: 36, bond: 40 }, priority: 1 }],
  "haunter>gengar": [
    { needs: { level: 32, bond: 40, night: true }, priority: 1 },
    { needs: { level: 32, bond: 64, daytime: true }, priority: 2 },
  ],

  "growlithe>arcanine": [
    { needs: { level: 26, bond: 36, care: true }, priority: 1 },
    { needs: { level: 22, bond: 26, weatherKind: "sun" }, priority: 3 },
  ],
  "vulpix>ninetales": [
    { needs: { level: 30, bond: 42 }, priority: 1 },
    { needs: { level: 26, bond: 30, weatherKind: "sun", care: true }, priority: 3 },
  ],

  "poliwhirl>poliwrath": [
    { needs: { level: 36, bond: 48, care: true }, priority: 2 },
    { needs: { level: 30, bond: 32, weatherKind: "rain" }, priority: 3 },
  ],
  "shellder>cloyster": [
    { needs: { level: 26, bond: 38, care: true }, priority: 1 },
    { needs: { level: 22, bond: 28, weatherKind: "rain" }, priority: 3 },
  ],
  "staryu>starmie": [
    { needs: { level: 28, bond: 38 }, priority: 1 },
    { needs: { level: 24, bond: 28, weatherKind: "rain", night: true }, priority: 3 },
  ],

  "gloom>vileplume": [
    { needs: { level: 32, bond: 42, daytime: true }, priority: 1 },
    { needs: { level: 28, bond: 30, warmHumid: true }, priority: 3 },
  ],
  "weepinbell>victreebel": [
    { needs: { level: 34, bond: 42 }, priority: 1 },
    { needs: { level: 30, bond: 30, warmHumid: true }, priority: 3 },
  ],
  "exeggcute>exeggutor": [
    { needs: { level: 28, bond: 40, daytime: true }, priority: 1 },
    { needs: { level: 24, bond: 28, warmHumid: true }, priority: 3 },
  ],

  "clefairy>clefable": [
    { needs: { level: 30, bond: 44, daytime: true }, priority: 2 },
    { needs: { level: 26, bond: 32, night: true }, priority: 3 },
  ],
  "jigglypuff>wigglytuff": [
    { needs: { level: 30, bond: 42, care: true }, priority: 1 },
    { needs: { level: 26, bond: 32, night: true }, priority: 3 },
  ],
  "nidorina>nidoqueen": [
    { needs: { level: 34, bond: 44, care: true }, priority: 1 },
    { needs: { level: 30, bond: 34, night: true }, priority: 3 },
  ],
  "nidorino>nidoking": [
    { needs: { level: 36, bond: 44 }, priority: 1 },
    { needs: { level: 32, bond: 34, night: true }, priority: 3 },
  ],

  "pikachu>raichu": [
    { needs: { level: 30, bond: 42 }, priority: 1 },
    { needs: { level: 26, bond: 30, streak: 12 }, priority: 3 },
  ],

  "eevee>vaporeon": [{ needs: { bond: 56, weatherKind: "rain" }, priority: 3 }],
  "eevee>jolteon": [{ needs: { bond: 56, streak: 12 }, priority: 3 }],
  "eevee>flareon": [{ needs: { bond: 56, weatherKind: "sun" }, priority: 3 }],
};

const generated = existsSync(GENERATED) ? JSON.parse(readFileSync(GENERATED, "utf8")) : {};
const links = JSON.parse(readFileSync(ITEM_LINKS, "utf8"));

// Every branch that will exist alongside these, so R1 can be asked of the
// SPECIES rather than of this file's slice of it. eevee's five hand-authored
// roads are the whole point: three of them need nothing unarrangeable, which is
// what makes it legal for all three item roads here to want their own weather.
// _special.json is skipped -- it is this script's own output.
const existingBranches = new Map();
for (const file of readdirSync(DIR)) {
  if (!file.endsWith(".json") || file === "_special.json") continue;
  const part = JSON.parse(readFileSync(`${DIR}${file}`, "utf8"));
  for (const [species, node] of Object.entries(part)) {
    existingBranches.set(species, [...(existingBranches.get(species) ?? []), ...(node.branches ?? [])]);
  }
}

// ---------------------------------------------------------------- the asserts
//
// Every one of these has already happened at least once in this directory. They
// are cheap and they are the only thing standing between a thoughtful design and
// a branch that silently never fires.
const problems = [];

const covered = new Set();
for (const link of links) {
  const key = `${link.from}>${link.to}`;
  covered.add(key);
  if (!SUBSTITUTES[key]) problems.push(`no substitute for ${key} (${link.requires})`);
  // R4: the canonical table must not already reach this target from here.
  if ((generated[link.from]?.branches ?? []).some((b) => b.to === link.to)) {
    problems.push(`${key} is already reachable from _generated.json`);
  }
}
for (const key of Object.keys(SUBSTITUTES)) {
  if (!covered.has(key)) problems.push(`${key} is not an item link -- nothing to substitute for`);
}

// A species with one target must keep a road needing nothing unarrangeable (R1);
// a species with several must keep one somewhere among them.
const roadsBySource = new Map();
for (const [key, branches] of Object.entries(SUBSTITUTES)) {
  const [from, to] = key.split(">");
  for (const branch of branches) {
    for (const [need, value] of Object.entries(branch.needs)) {
      if (NUMERIC.has(need)) {
        if (typeof value !== "number") problems.push(`${key}: ${need} must be a number`);
      } else if (!STATE.has(need)) {
        problems.push(`${key}: unknown need ${need} (cold is banned, see R2)`);
      }
    }
    if (branch.needs.cold != null) problems.push(`${key}: cold is unreachable here (R2)`);
  }
  const arrangeable = branches.some((b) => Object.keys(b.needs).every((n) => !UNARRANGEABLE.has(n)));
  const existing = existingBranches.get(from) ?? [];
  const arrangeableElsewhere = existing.some((b) => Object.keys(b.needs ?? {}).every((n) => !UNARRANGEABLE.has(n)));
  const targets = roadsBySource.get(from) ?? { targets: new Set(), arrangeable: arrangeableElsewhere };
  targets.targets.add(to);
  targets.arrangeable ||= arrangeable;
  roadsBySource.set(from, targets);
}
// Judged only once every target of a species is known: eevee's individual roads
// may each want their own weather so long as the species keeps one that does not.
for (const [from, info] of roadsBySource) {
  if (!info.arrangeable) problems.push(`${from}: every road needs weather, night or a streak (R1)`);
}

if (problems.length) throw new Error(`substitute table is not sound:\n  ${problems.join("\n  ")}`);

// ----------------------------------------------------------------- the output
const stageOf = new Map();
for (const link of links) {
  stageOf.set(link.from, link.stage);
  if (!stageOf.has(link.to)) stageOf.set(link.to, link.stage + 1);
}

const table = {};
for (const [key, branches] of Object.entries(SUBSTITUTES)) {
  const [from, to] = key.split(">");
  // Stage comes from the canonical inventory so the two can never disagree about
  // where in its line a species sits.
  const stage = generated[from]?.stage ?? stageOf.get(from);
  if (stage == null) throw new Error(`${from} has no stage -- run gen-evolution.mjs first`);
  const node = (table[from] ??= { stage, branches: [] });
  for (const branch of branches) node.branches.push({ to, needs: branch.needs, priority: branch.priority });
  // The target needs an entry of its own, or it looks like a species missing
  // from the table rather than a terminal form. Only added when the canonical
  // generator did not already record it.
  if (!generated[to]) table[to] ??= { stage: stage + 1, branches: [] };
}

for (const node of Object.values(table)) {
  node.branches.sort((a, b) => a.priority - b.priority || a.to.localeCompare(b.to));
}

const sorted = Object.fromEntries(Object.entries(table).sort((a, b) => a[0].localeCompare(b[0])));
writeFileSync(OUT, `${JSON.stringify(sorted, null, 2)}\n`);

// Counts only, even here -- this output can end up in a terminal the owner reads.
const branchCount = Object.values(SUBSTITUTES).reduce((n, b) => n + b.length, 0);
console.log(`wrote ${OUT}`);
console.log(`  item/trade links covered : ${links.length}`);
console.log(`  source forms             : ${roadsBySource.size}`);
console.log(`  branches written         : ${branchCount}`);
console.log(`  terminal forms added     : ${Object.values(sorted).filter((n) => !n.branches.length).length}`);
console.log(`  soundness problems       : 0`);
