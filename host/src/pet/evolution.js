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
// `stage` takes the first definition; branches accumulate, deduped by target so
// re-reading a file (or two files agreeing) cannot double an entry.
const TABLE = {};
for (const file of readdirSync(DIR).sort()) {
  if (!file.endsWith(".json")) continue;
  const part = JSON.parse(readFileSync(fileURLToPath(new URL(file, DIR)), "utf8"));
  for (const [species, node] of Object.entries(part)) {
    const target = (TABLE[species] ??= { stage: node.stage, branches: [] });
    if (target.stage == null) target.stage = node.stage;
    for (const branch of node.branches ?? []) {
      if (!target.branches.some((existing) => existing.to === branch.to)) target.branches.push(branch);
    }
  }
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
  if (candidates.length === 0) return { auto: null, candidates: [] };

  const stone = ctx.stone ? candidates.find((branch) => branch.needs.stone === ctx.stone) : null;
  if (stone) return { auto: stone.to, candidates };
  const care = candidates.find((branch) => branch.priority === 1 && branch.needs?.care === true);
  if (care) return { auto: care.to, candidates };
  if (candidates.length === 1) return { auto: candidates[0].to, candidates };

  return { auto: null, candidates };
}

function needsMet(needs, ctx) {
  return Object.entries(needs).every(([key, value]) => {
    if (key === "bond") return (ctx.bond ?? 0) >= value;
    if (key === "level") return (ctx.level ?? 0) >= value;
    if (key === "stone") return ctx.stone === value;
    return ctx[key] === value;
  });
}
