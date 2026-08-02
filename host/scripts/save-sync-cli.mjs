#!/usr/bin/env node
// Manual driver for the save sync the host runs automatically (src/save-sync.js).
// Useful for the first bootstrap on a new machine, and for answering "which
// buddy does the remote actually hold right now" without starting the host.
//
//   node scripts/save-sync-cli.mjs status
//   node scripts/save-sync-cli.mjs pull
//   node scripts/save-sync-cli.mjs push [--allow-loss]
//
// `push` refuses when the remote holds 图鉴/捕捉 this machine does not, since
// that is a save from the other machine's turn and publishing over it is how a
// weekend went missing on 2026-08-03. --allow-loss is for the one legitimate
// case: you removed something from the save by hand and mean it.
//
// Run it from host/. Reads config.json's saveSync block for remote/branch.
import { existsSync, readFileSync } from "node:fs";

import { loadConfig } from "../src/config.js";
import { createSaveSync } from "../src/save-sync.js";
import { displayName } from "../src/pet/species-meta.js";

const command = process.argv[2] ?? "status";
const statePath = process.env.CPB_STATE_PATH ?? "out/state.json";
const config = loadConfig("config.json");
const settings = config.saveSync ?? {};
const ownerName = config.name;

if (!settings.enabled) {
  console.error('config.json has no enabled "saveSync" block -- nothing to sync.');
  process.exit(2);
}

const sync = createSaveSync({
  statePath,
  remote: settings.remote,
  branch: settings.branch,
  pushIntervalMs: settings.pushIntervalMs,
});

const { remote, branch } = sync.describe();

if (command === "status") {
  // The whole point of status is answering "which way do I sync?", so it prints
  // the remote's save, not just the remote's name -- printing the name was all
  // it did until 2026-07-29, which made the handoff's "stop if the remote is
  // behind" instruction impossible to follow.
  const peeked = await sync.peek();
  console.log(`remote : ${remote}/${branch}`);
  console.log(`         ${describeRemote(peeked)}`);
  console.log(`local  : ${describeSave(statePath)}`);
  console.log(`         ${verdict(peeked)}`);
  process.exit(0);
}

if (command !== "pull" && command !== "push") {
  console.error(`unknown command "${command}" (expected status | pull | push)`);
  process.exit(2);
}

const allowLoss = process.argv.includes("--allow-loss");
const before = describeSave(statePath);
const result = command === "pull"
  ? await sync.pull()
  : await sync.maybePush({ force: true, allowLoss });
console.log(`${command}: ${result.status}${result.detail ? ` -- ${result.detail}` : ""}`);
if (command === "pull") {
  console.log(`before : ${before}`);
  console.log(`after  : ${describeSave(statePath)}`);
}
// Everything here is a normal outcome: "ours-already" means the remote tip is
// our own publish and there is nothing to take, "already-current" means the
// contents match, "no-remote-save" is a first run. None are failures.
const ok = ["pulled", "pushed", "already-current", "ours-already", "no-remote-save"].includes(result.status);
process.exit(ok ? 0 : 1);

function describeSave(path) {
  if (!existsSync(path)) return "(no save file)";
  try {
    const save = JSON.parse(readFileSync(path, "utf8"));
    return summarise(save);
  } catch {
    return "(unparseable)";
  }
}

// Composed the same way every other surface names a pokemon (displayName), so
// two screens can never disagree about who this is. Notably NOT the save's own
// `name` field: that is written once at onboarding and never follows an
// evolution, so it printed "妙蛙种子 (ivysaur)" -- a name and species that do
// not match, in the one command whose job is to rule the two-buddy trap in or
// out. The raw key stays alongside it because this is a diagnostic.
// 图鉴/捕捉 are printed alongside the level because they are what actually
// distinguishes two saves at a glance. On 2026-08-03 the stale copy happened to
// share a level with the real one and differed only in the collection, and this
// line said they were both "Lv.11" and nothing more. Counts, never species.
function summarise(save) {
  const who = save.species ? `${displayName(ownerName, save.species)} (${save.species})` : "?";
  const dex = Array.isArray(save.dexCaught) ? save.dexCaught.length : 0;
  const box = Array.isArray(save.box) ? save.box.length : 0;
  return `${who} Lv.${save.level} exp=${save.exp} bond=${save.bond} streak=${save.streak}`
    + ` 图鉴=${dex} 捕捉=${save.capturedCount ?? 0} box=${box}`;
}

function describeRemote(peeked) {
  if (peeked.status === "ok") return summarise(peeked.save);
  if (peeked.status === "no-remote-save") return "(nothing published yet)";
  return `(unreadable: ${peeked.status}${peeked.detail ? ` -- ${String(peeked.detail).trim().split("\n")[0]}` : ""})`;
}

// Says which way to sync, because that is the decision this command exists to
// support. It stops short of running anything: the pull is destructive to the
// local save and stays a separate, deliberate step.
function verdict(peeked) {
  if (peeked.status === "no-remote-save") return "→ nothing to pull; push once this machine has the device";
  if (peeked.status !== "ok") return "→ cannot tell -- fix the error above before syncing";
  if (peeked.identical) return "→ already the same save, nothing to do";
  if (peeked.ours) {
    return "→ the remote tip is this machine's own publish, so local is ahead of it. "
      + "Do NOT pull (it would roll back); push if the device is attached here.";
  }
  return "→ the remote holds someone else's newer turn with the device. "
    + "Pull if the device is now here; see the two-buddy trap in docs/handoff.md if the species or nature differ.";
}
