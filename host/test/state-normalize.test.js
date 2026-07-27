import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, SCHEMA_VERSION } from "../src/state.js";
import { expToNextLevel, PARAMS } from "../src/pet/sim.js";
import { settleDays } from "../src/pet/settlement.js";

test("loadState drops garbage lastSettled so settlement cannot throw", (t) => {
  const { file } = tempState(t);
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      hatched: true,
      level: 2,
      exp: 7,
      bond: 50,
      streak: 3,
      shield: 1,
      lastSettled: "garbage",
    }),
  );

  const loaded = loadState(file);

  assert.equal(loaded.lastSettled, undefined);
  assert.doesNotThrow(() => {
    settleDays(loaded, "2026-07-05", { usedDays: new Set() });
  });
});

test("loadState drops semantically invalid date strings", (t) => {
  for (const value of ["2026-99-99", "2026-02-30"]) {
    const { file } = tempState(t);
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        hatched: true,
        level: 2,
        exp: 7,
        bond: 50,
        streak: 3,
        shield: 1,
        lastSettled: value,
        lastGrowthDay: value,
      }),
    );

    const loaded = loadState(file);

    assert.equal(loaded.lastSettled, undefined);
    assert.equal(loaded.lastGrowthDay, undefined);
    assert.doesNotThrow(() => {
      settleDays(loaded, "2026-07-05", { usedDays: new Set() });
    });
  }
});

test("loadState clamps out-of-range fast-path numbers", (t) => {
  const { file } = tempState(t);
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      hatched: true,
      level: -5,
      bond: -999,
      exp: 5e9,
      streak: -3,
      shield: 999,
      careCount: -2,
      todayCreditedExp: -10,
      todayCreditedBond: -20,
    }),
  );

  const loaded = loadState(file);

  assert.equal(loaded.level, 1);
  assert.equal(loaded.bond, 0);
  assert.equal(loaded.exp, expToNextLevel(1) - 1, "exp is clamped to the level's own bar, not a flat constant");
  assert.equal(loaded.streak, 0);
  assert.equal(loaded.shield, 2);
  assert.equal(loaded.careCount, 0);
  assert.equal(loaded.todayCreditedExp, 0);
  assert.equal(loaded.todayCreditedBond, 0);
});

test("loadState salvage drops out-of-range numeric backup fields", (t) => {
  const { file } = tempState(t);
  writeFileSync(file, "{corrupt");
  writeFileSync(
    `${file}.bak`,
    JSON.stringify({
      schemaVersion: 999,
      level: -5,
      bond: -999,
      exp: 5e9,
      streak: -3,
      shield: 999,
    }),
  );

  const loaded = loadState(file, { logger: { warn() {} } });

  assert.equal(loaded.level, undefined);
  assert.equal(loaded.bond, undefined);
  assert.equal(loaded.exp, undefined);
  assert.equal(loaded.streak, undefined);
  assert.equal(loaded.shield, undefined);
});

function tempState(t) {
  const dir = mkdtempSync(join(tmpdir(), "cpb-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, "state.json") };
}
