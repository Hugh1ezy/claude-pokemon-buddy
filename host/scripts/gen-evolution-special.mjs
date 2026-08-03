#!/usr/bin/env node
// ⚠ SPOILER FILE. Read and edit freely; never let its contents reach the owner.
//
// Build seed/evolution/_special.json -- the five Generation 1 trade evolutions,
// given conditions this device can actually satisfy.
//
//   cd host && node scripts/gen-evolution-special.mjs
//
// The owner asked on 2026-08-03 for this specifically to be designed without
// him: 「这是你自己要设计的保密项，不能给我看，是惊喜」. So what each of these
// five needs is not in any commit message, any doc, any log line or any test
// name -- it lives here and in the JSON this writes, and both are listed as
// spoiler files in CLAUDE.md. Report counts if you must report anything.
//
// ## The design, and why
//
// A trade in the games meant the one thing a solitary trainer could not do
// alone: hand the pokemon to someone else and get it back changed. There is no
// second person here, so the substitute has to mean "this took more than
// levelling it up" without meaning "grind harder" -- a level floor alone would
// make these five indistinguishable from the sixty ordinary level-up lines and
// would waste the only place in the game where evolution is allowed to feel
// like a small event.
//
// So each of the five pairs a level floor with a condition about how the buddy
// has been LOOKED AFTER or WHERE IT HAS BEEN. Those are the two axes the device
// can actually observe (`evolutionContext` in src/pet/transitions.js supplies
// bond, level, care, daytime/night, warmHumid, cold), and they are the axes
// eevee.json already uses -- so these read as part of the same game rather than
// as a bolted-on rule.
//
// Two constraints that shaped every one of them:
//
//  * `needsMet` treats `bond` and `level` as >= and everything else as strict
//    equality, so `careCount: 5` would mean EXACTLY five and would be unreachable
//    forever. Only `bond`/`level` may carry a threshold. This is exactly the class
//    of silent dead branch that left 63 species unable to evolve at all.
//  * Every condition below must be satisfiable at both of the owner's locations
//    and in any weather. `warmHumid`/`cold` are therefore never used ALONE as a
//    gate here -- an evolution that needs a cold snap in a Wellington summer is
//    an evolution that never happens. They appear only as an alternative branch
//    alongside one that does not need them.
//
// ## The five
//
// Level floors sit a little above the line's ordinary evolution level, so these
// stay the last thing that happens to their line rather than the first.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../seed/evolution/", import.meta.url));
const GENERATED = `${DIR}_generated.json`;
const OUT = `${DIR}_special.json`;

// from -> to, plus what stands in for the trade.
//
// kadabra   the psychic that bends spoons at a distance; it changes when it has
//           been paid enough attention to bother. care + a high bond.
// machoke   the one that trains. it needs the hours, and it needs someone there
//           for them: a high level AND sustained care.
// graveler  rolls downhill and comes back. the rock line gets a level floor and
//           a bond floor -- nothing environmental, because it must not depend on
//           weather the owner cannot arrange.
// haunter   a ghost, so it gets the one genuinely atmospheric condition in the
//           set: at night. paired with an alternative daytime branch at a higher
//           bond so a daytime-only week cannot lock it out.
const TRADES = [
  { from: "kadabra", to: "alakazam", branches: [
    { needs: { level: 20, bond: 40, care: true }, priority: 1 },
  ] },
  { from: "machoke", to: "machamp", branches: [
    { needs: { level: 36, bond: 48, care: true }, priority: 1 },
  ] },
  { from: "graveler", to: "golem", branches: [
    { needs: { level: 36, bond: 40 }, priority: 1 },
  ] },
  { from: "haunter", to: "gengar", branches: [
    { needs: { level: 32, bond: 40, night: true }, priority: 1 },
    { needs: { level: 32, bond: 64, daytime: true }, priority: 2 },
  ] },
  // The fifth Gen-1 trade link. Same line as one above, and it takes the same
  // shape for the same reason.
  { from: "poliwhirl", to: "poliwrath", branches: [
    { needs: { level: 36, bond: 48, care: true }, priority: 2 },
  ] },
];

const generated = existsSync(GENERATED) ? JSON.parse(readFileSync(GENERATED, "utf8")) : {};

const table = {};
for (const trade of TRADES) {
  // Stage comes from the canonical table so the two can never disagree about
  // where in its line a species sits.
  const stage = generated[trade.from]?.stage;
  if (stage == null) throw new Error(`${trade.from} is not in _generated.json -- run gen-evolution.mjs first`);
  table[trade.from] = {
    stage,
    branches: trade.branches.map((b) => ({ to: trade.to, needs: b.needs, priority: b.priority })),
  };
  // The target needs an entry of its own, or it looks like a species missing
  // from the table rather than a terminal form. Only added when the canonical
  // generator did not already record it (it does not: these targets are only
  // ever reached by a dropped trade link).
  if (!generated[trade.to]) table[trade.to] ??= { stage: stage + 1, branches: [] };
}

writeFileSync(OUT, `${JSON.stringify(table, null, 2)}\n`);

// Counts only, even here -- this line can end up in a terminal the owner reads.
console.log(`wrote ${OUT}`);
console.log(`  source forms : ${TRADES.length}`);
console.log(`  branches     : ${TRADES.reduce((n, t) => n + t.branches.length, 0)}`);
console.log(`  terminal forms added: ${Object.values(table).filter((n) => !n.branches.length).length}`);
