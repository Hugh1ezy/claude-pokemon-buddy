import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = new URL("../../seed/evolution/", import.meta.url);
// Merged per species, not Object.assign'd. Two files may legitimately describe
// the same species -- a generated canonical branch and a hand-authored one --
// and Object.assign replaces the whole node, so which branches existed came
// down to readdir order. That is not a decision anyone made, and the symptom
// would be a branch that silently is not there, which is precisely the failure
// this directory already produced once by being incomplete.
//
// `stage` takes the first definition; branches accumulate, deduped by the WHOLE
// branch so re-reading a file (or two files agreeing) cannot double an entry.
//
// Deduping on `to` alone was the obvious reading and it was wrong, twice over.
// A species is allowed more than one road to the same destination -- an ordinary
// route, plus a shortcut that wants the weather or the hour to cooperate -- and
// keying on the target threw the second road away at LOAD time, before any
// condition was ever evaluated. Measured 2026-09-04: haunter's daytime fallback
// and one whole trade substitute were both being dropped on the floor, and both
// looked exactly like a condition that simply had not been met yet. That is the
// worst shape a bug can have here, because the only symptom is a pokemon that
// never evolves and no way to tell that from patience.
//
// The identity of a branch is target + conditions + priority. Two files that
// genuinely agree still collapse to one entry; two files that differ keep both,
// which is the only answer that cannot lose a road nobody meant to close.
const TABLE = {};
for (const file of readdirSync(DIR).sort()) {
  if (!file.endsWith(".json")) continue;
  const part = JSON.parse(readFileSync(fileURLToPath(new URL(file, DIR)), "utf8"));
  for (const [species, node] of Object.entries(part)) {
    const target = (TABLE[species] ??= { stage: node.stage, branches: [] });
    if (target.stage == null) target.stage = node.stage;
    for (const branch of node.branches ?? []) {
      if (!target.branches.some((existing) => sameBranch(existing, branch))) target.branches.push(branch);
    }
  }
}

function sameBranch(a, b) {
  return a.to === b.to && a.priority === b.priority && sameNeeds(a.needs, b.needs);
}

function sameNeeds(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

export function eligibleBranches(species, ctx = {}) {
  const node = TABLE[species];
  if (!node) return [];

  return node.branches
    .filter((branch) => needsMet(branch.needs, ctx))
    .sort((a, b) => a.priority - b.priority);
}

export function resolveEvolution(species, ctx = {}) {
  const candidates = eligibleBranches(species, ctx);
  return { auto: chooseAuto(candidates), candidates };
}

// Which of the eligible branches KEY should act on, or null to ask the owner.
// Exported so the rule can be tested against branches made up on the spot: the
// real tables are a spoiler, and a test that had to name a real condition to
// reach this code would put one in a file he reads.
export function chooseAuto(candidates) {
  if (candidates.length === 0) return null;

  const care = candidates.find((branch) => branch.priority === 1 && branch.needs?.care === true);
  if (care) return care.to;

  // One destination, however many roads reach it. A line whose eligible branches
  // all name the same species has nothing to choose between, so it evolves on
  // KEY instead of offering the owner two buttons with the same word on them.
  // This is what lets a branch PAIR -- an ordinary route and a shortcut that
  // wants the weather to cooperate -- describe one evolution rather than a fork.
  const targets = new Set(candidates.map((branch) => branch.to));
  if (targets.size === 1) return candidates[0].to;

  return null;
}

// Numeric needs are floors; everything else is exact. The distinction is not
// cosmetic: `careCount: 5` read as equality means EXACTLY five and is false the
// moment a sixth arrives, which is a branch that is open for one tick in its
// life. Any need that names a quantity belongs in this set, and a need that
// names a state (`care`, `night`, `warmHumid`, `weatherKind`) must not.
const THRESHOLDS = new Set(["bond", "level", "streak", "careCount"]);

function needsMet(needs, ctx) {
  return Object.entries(needs).every(([key, value]) => {
    if (THRESHOLDS.has(key)) return (Number(ctx[key]) || 0) >= value;
    return ctx[key] === value;
  });
}
