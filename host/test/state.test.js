import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState, SCHEMA_VERSION } from "../src/state.js";

test("saveState/loadState roundtrip adds schemaVersion and leaves no tmp file", (t) => {
  const { dir, file } = tempState(t);

  saveState(file, { level: 3, bond: 120, lastSettled: "2026-05-28" });
  const loaded = loadState(file);

  assert.equal(loaded.schemaVersion, SCHEMA_VERSION);
  assert.equal(loaded.level, 3);
  assert.equal(loaded.bond, 120);
  assert.equal(existsSync(`${file}.tmp`), false);
  assert.equal(existsSync(dir), true);
});

test("care days survive a roundtrip, a salvage, and stay absent when never earned", (t) => {
  const { file } = tempState(t);

  saveState(file, { level: 3, careDays: ["2026-08-13", "2026-08-12", "2026-08-12", "nope"] });
  const loaded = loadState(file);
  assert.deepEqual(loaded.careDays, ["2026-08-12", "2026-08-13"]);

  // A save from before care days existed must round-trip unchanged, or every
  // load/save would hand save-sync a difference to publish.
  saveState(file, { level: 3 });
  assert.equal("careDays" in loadState(file), false);

  // Salvage: a day the owner turned up cannot be re-earned once it is past.
  writeFileSync(file, JSON.stringify({ schemaVersion: 99, level: 3, careDays: ["2026-08-13"] }));
  rmSync(`${file}.bak`, { force: true });
  assert.deepEqual(loadState(file, { logger: null }).careDays, ["2026-08-13"]);
});

test("saveState creates backup and corrupt main falls back to previous backup", (t) => {
  const { file } = tempState(t);

  saveState(file, { level: 7 });
  saveState(file, { level: 8 });
  writeFileSync(file, "{corrupt");

  assert.equal(JSON.parse(readFileSync(`${file}.bak`, "utf8")).level, 7);
  assert.equal(loadState(file).level, 7);
});

test("saveState preserves a good backup when the primary is corrupt", (t) => {
  const { file } = tempState(t);
  writeFileSync(file, "{corrupt-primary");
  writeFileSync(`${file}.bak`, JSON.stringify({ schemaVersion: SCHEMA_VERSION, level: 7 }));

  saveState(file, { level: 8 });

  assert.equal(JSON.parse(readFileSync(file, "utf8")).level, 8);
  assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, "utf8")), {
    schemaVersion: SCHEMA_VERSION,
    level: 7,
  });
});

test("saveState refreshes backup when the primary is parseable", (t) => {
  const { file } = tempState(t);
  writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, level: 7 }));

  saveState(file, { level: 8 });

  assert.equal(JSON.parse(readFileSync(file, "utf8")).level, 8);
  assert.equal(JSON.parse(readFileSync(`${file}.bak`, "utf8")).level, 7);
});

test("loadState safely rebuilds and salvages parseable fields when main and backup are invalid", (t) => {
  const { file } = tempState(t);
  const warnings = [];
  writeFileSync(file, JSON.stringify({ schemaVersion: 999, level: 99 }));
  writeFileSync(`${file}.bak`, "{corrupt");

  const loaded = loadState(file, {
    logger: {
      warn(message, meta) {
        warnings.push({ message, meta });
      },
    },
  });

  assert.deepEqual(loaded, { schemaVersion: SCHEMA_VERSION, _rebuilt: true, level: 99 });
  assert.equal(warnings.length, 1);
});

test("loadState rebuilds missing first-run state without warning", (t) => {
  const { file } = tempState(t);
  const warnings = [];

  const loaded = loadState(file, {
    logger: {
      warn(message, meta) {
        warnings.push({ message, meta });
      },
    },
  });

  assert.deepEqual(loaded, { schemaVersion: SCHEMA_VERSION, _rebuilt: true });
  assert.equal(warnings.length, 0);
});

test("loadState warns and salvages level and evolution fields from a partially parseable backup", (t) => {
  const { file } = tempState(t);
  const warnings = [];
  writeFileSync(file, "{corrupt");
  writeFileSync(
    `${file}.bak`,
    JSON.stringify({
      schemaVersion: 999,
      species: "umbreon",
      level: 42,
      exp: 7,
      bond: 170,
      readyToEvolve: true,
      pendingCandidates: [{ to: "sylveon" }],
    }),
  );

  const loaded = loadState(file, {
    logger: {
      warn(message, meta) {
        warnings.push({ message, meta });
      },
    },
  });

  assert.equal(loaded.schemaVersion, SCHEMA_VERSION);
  assert.equal(loaded._rebuilt, true);
  assert.equal(loaded.species, "umbreon");
  assert.equal(loaded.level, 42);
  assert.equal(loaded.exp, 7);
  assert.equal(loaded.bond, 170);
  assert.equal(loaded.readyToEvolve, true);
  assert.deepEqual(loaded.pendingCandidates, [{ to: "sylveon" }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /state/i);
});

test("loadState salvage preserves the personality tuple", (t) => {
  const { file } = tempState(t);
  writeFileSync(file, "{corrupt");
  writeFileSync(
    `${file}.bak`,
    JSON.stringify({
      schemaVersion: 999,
      species: "eevee",
      iv: [31, 0, 12, 18, 24, 7],
      nature: "急性子",
      characteristic: "爱睡午觉",
    }),
  );

  const loaded = loadState(file, { logger: { warn() {} } });

  assert.deepEqual(loaded.iv, [31, 0, 12, 18, 24, 7]);
  assert.equal(loaded.nature, "急性子");
  assert.equal(loaded.characteristic, "爱睡午觉");
});

function tempState(t) {
  const dir = mkdtempSync(join(tmpdir(), "cpb-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, "state.json") };
}
