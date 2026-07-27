#!/usr/bin/env node
// Manual driver for the save sync the host runs automatically (src/save-sync.js).
// Useful for the first bootstrap on a new machine, and for answering "which
// buddy does the remote actually hold right now" without starting the host.
//
//   node scripts/save-sync-cli.mjs status
//   node scripts/save-sync-cli.mjs pull
//   node scripts/save-sync-cli.mjs push
//
// Run it from host/. Reads config.json's saveSync block for remote/branch.
import { existsSync, readFileSync } from "node:fs";

import { loadConfig } from "../src/config.js";
import { createSaveSync } from "../src/save-sync.js";

const command = process.argv[2] ?? "status";
const statePath = process.env.CPB_STATE_PATH ?? "out/state.json";
const config = loadConfig("config.json");
const settings = config.saveSync ?? {};

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
  console.log(`remote : ${remote}/${branch}`);
  console.log(`local  : ${describeSave(statePath)}`);
  process.exit(0);
}

if (command !== "pull" && command !== "push") {
  console.error(`unknown command "${command}" (expected status | pull | push)`);
  process.exit(2);
}

const before = describeSave(statePath);
const result = command === "pull" ? await sync.pull() : await sync.maybePush({ force: true });
console.log(`${command}: ${result.status}${result.detail ? ` -- ${result.detail}` : ""}`);
if (command === "pull") {
  console.log(`before : ${before}`);
  console.log(`after  : ${describeSave(statePath)}`);
}
// "already-current" and "no-remote-save" are both fine outcomes, not failures.
const ok = ["pulled", "pushed", "already-current", "no-remote-save"].includes(result.status);
process.exit(ok ? 0 : 1);

function describeSave(path) {
  if (!existsSync(path)) return "(no save file)";
  try {
    const save = JSON.parse(readFileSync(path, "utf8"));
    return `${save.name ?? "?"} (${save.species}) Lv.${save.level} exp=${save.exp} bond=${save.bond} streak=${save.streak}`;
  } catch {
    return "(unparseable)";
  }
}
