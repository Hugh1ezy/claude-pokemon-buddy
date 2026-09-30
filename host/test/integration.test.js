import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runOneTick } from "../src/index.js";
import { PARAMS } from "../src/pet/sim.js";
import { createMockTransport } from "../src/transport/mock.js";

test("one tick produces frame and advances state", async () => {
  const statePath = join("out", "test-state.json");
  const framePath = join("out", "test-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(framePath, { force: true });

  const state = await runOneTick({
    usage: {
      p5h: 72,
      pweek: 41,
      todayCost: 4.1,
      todayTokens: 5_300_000,
      modelled: true,
      weekTokens: 30_000_000,
    },
    weather: {
      cond: "多云",
      temp: 19,
      feels: 17,
      hi: 22,
      lo: 14,
      precip: 30,
      wind: 11,
      humidity: 64,
    },
    room: { t: 23.4, h: 56 },
    statePath,
    framePath,
    mock: createMockTransport({ framePath }),
    today: "2026-05-30",
  });

  assert.equal(existsSync(framePath), true);
  assert.equal(existsSync(statePath), true);
  assert.equal(state.level, 1);
  assert.equal(state.expGain, 0);
  assert.equal(state.lastGrowthDay, "2026-05-30");
});

test("same-day usage growth credits only new token progress", async () => {
  const statePath = join("out", "test-growth-delta-state.json");
  const framePath = join("out", "test-growth-delta-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(framePath, { force: true });

  const first = await runOneTick({
    usage: usageWithTokens(1_000),
    weather: sampleWeather(),
    room: { t: 23.4, h: 56 },
    statePath,
    framePath,
    mock: createMockTransport({ framePath }),
    today: "2026-05-30",
  });
  const second = await runOneTick({
    usage: usageWithTokens(2_000),
    weather: sampleWeather(),
    room: { t: 23.4, h: 56 },
    statePath,
    framePath,
    mock: createMockTransport({ framePath }),
    today: "2026-05-30",
  });

  // Derived from PARAMS rather than written out: these numbers moved when the
  // daily yield was doubled on 2026-09-09, and the thing under test is the
  // DELTA -- that a second tick on the same day credits only the new tokens --
  // not what a thousand tokens happen to be worth this month.
  const perKTok = PARAMS.expPerKTok;
  assert.equal(first.expGain, 0, "a newborn anchors the day it is born, it does not claim it");
  assert.equal(first.todayCreditedExp, perKTok, "1k tokens anchored");
  assert.equal(second.expGain, perKTok, "the second 1k, and only the second");
  assert.equal(second.exp, perKTok);
  assert.equal(second.todayCreditedExp, 2 * perKTok);
  assert.equal(second.todayCreditedBond, PARAMS.bondPerActiveDay);
});

test("fresh pet state rolls personality on first tick", async () => {
  const statePath = join("out", "test-personality-fresh-state.json");
  const framePath = join("out", "test-personality-fresh-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(framePath, { force: true });

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: sampleWeather(),
    room: { t: 23.4, h: 56 },
    statePath,
    framePath,
    mock: createMockTransport({ framePath }),
    today: "2026-05-30",
    personalityRng: sequenceRng([0.12, 0.22, 0.32, 0.42, 0.52, 0.62, 0.2]),
  });

  assert.equal(typeof state.nature, "string");
  assert.notEqual(state.nature, "");
  assert.equal(state.iv.length, 6);
  assert.equal(typeof state.characteristic, "string");
  assert.notEqual(state.characteristic, "");
});

test("existing pet keeps personality across ticks", async () => {
  const statePath = join("out", "test-personality-stable-state.json");
  const framePath = join("out", "test-personality-stable-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(framePath, { force: true });

  const first = await runOneTick({
    usage: usageWithTokens(0),
    weather: sampleWeather(),
    room: { t: 23.4, h: 56 },
    statePath,
    framePath,
    mock: createMockTransport({ framePath }),
    today: "2026-05-30",
    personalityRng: sequenceRng([0.12, 0.22, 0.32, 0.42, 0.52, 0.62, 0.2]),
  });
  const second = await runOneTick({
    usage: usageWithTokens(1_000),
    weather: sampleWeather(),
    room: { t: 23.4, h: 56 },
    statePath,
    framePath,
    mock: createMockTransport({ framePath }),
    today: "2026-05-30",
    personalityRng: sequenceRng([0.99, 0.98, 0.97, 0.96, 0.95, 0.94, 0.93]),
  });

  assert.equal(typeof first.nature, "string");
  assert.equal(first.iv.length, 6);
  assert.equal(typeof first.characteristic, "string");
  assert.deepEqual(personalityOf(second), personalityOf(first));
});

test("old pet state missing personality is migrated on first tick", async () => {
  const statePath = join("out", "test-personality-migrate-state.json");
  const framePath = join("out", "test-personality-migrate-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(framePath, { force: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: 1,
      hatched: true,
      species: "eevee",
      level: 1,
      exp: 4,
      bond: 124,
      streak: 0,
      shield: 0,
      lastSettled: "2026-05-29",
      lastGrowthDay: "2026-05-30",
      todayCreditedExp: 4,
      todayCreditedBond: 4,
    }),
  );

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: sampleWeather(),
    room: { t: 23.4, h: 56 },
    statePath,
    framePath,
    mock: createMockTransport({ framePath }),
    today: "2026-05-30",
    personalityRng: sequenceRng([0.03, 0.13, 0.23, 0.33, 0.43, 0.53, 0.63]),
  });
  const persisted = JSON.parse(readFileSync(statePath, "utf8"));

  assert.deepEqual(personalityOf(persisted), personalityOf(state));
  assert.equal(typeof persisted.nature, "string");
  assert.equal(persisted.iv.length, 6);
  assert.equal(typeof persisted.characteristic, "string");
});

test("cross-day settlement freezes yesterday once and stays idempotent", async () => {
  const statePath = join("out", "test-cross-day-state.json");
  const framePath = join("out", "test-cross-day-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(framePath, { force: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: 1,
      hatched: true,
      species: "eevee",
      level: 1,
      exp: 4,
      bond: 124,
      streak: 0,
      shield: 0,
      lastSettled: "2026-05-29",
      lastGrowthDay: "2026-05-30",
      todayCreditedExp: 4,
      todayCreditedBond: 4,
    }),
  );

  const first = await runOneTick({
    usage: usageWithTokens(0),
    weather: sampleWeather(),
    room: { t: 23.4, h: 56 },
    statePath,
    framePath,
    mock: createMockTransport({ framePath }),
    today: "2026-05-31",
  });
  const second = await runOneTick({
    usage: usageWithTokens(0),
    weather: sampleWeather(),
    room: { t: 23.4, h: 56 },
    statePath,
    framePath,
    mock: createMockTransport({ framePath }),
    today: "2026-05-31",
  });

  assert.equal(first.lastSettled, "2026-05-30");
  assert.equal(first.streak, 1);
  assert.equal(first.todayCreditedExp, 0);
  assert.equal(first.todayCreditedBond, 0);
  assert.equal(second.lastSettled, "2026-05-30");
  assert.equal(second.streak, 1);
});

test("runOneTick sets the active cry id for the pet's species", async () => {
  const statePath = join("out", "test-cry-state.json");
  const framePath = join("out", "test-cry-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(framePath, { force: true });

  const cryCalls = [];
  const mock = createMockTransport({ framePath });
  mock.setActiveCry = (id) => cryCalls.push(id);

  await runOneTick({
    usage: usageWithTokens(1_000),
    weather: sampleWeather(),
    room: { t: 23.4, h: 56 },
    statePath,
    framePath,
    mock,
    today: "2026-05-30",
  });

  // 无 hatched 存档 → ensurePet 出 eevee → cryAudioId=3
  assert.ok(cryCalls.includes(3));
});

test("runOneTick reports the same render model shape used for buddy frames", async () => {
  const statePath = join("out", "test-render-model-state.json");
  const framePath = join("out", "test-render-model-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(framePath, { force: true });

  const models = [];
  await runOneTick({
    usage: usageWithTokens(1_000),
    weather: sampleWeather(),
    room: { t: 23.4, h: 56 },
    statePath,
    framePath,
    mock: createMockTransport({ framePath }),
    today: "2026-05-30",
    onRenderModel: (model) => models.push(model),
  });

  assert.equal(models.length, 1);
  assert.equal(models[0].buddy.species, "eevee");
  assert.ok(models[0].buddy.spriteGray instanceof Uint8Array);
  assert.equal(typeof models[0].buddy.bubble, "string");
  assert.equal(Object.hasOwn(models[0].buddy, "animPhase"), false);
});

test("offline days with real ccusage usage are not punished as missed (H1)", async () => {
  const statePath = join("out", "test-h1-active-state.json");
  const framePath = join("out", "test-h1-active-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(framePath, { force: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: 1,
      hatched: true,
      species: "eevee",
      level: 1,
      exp: 0,
      bond: 100,
      streak: 5,
      shield: 0,
      lastSettled: "2026-05-27",
      lastGrowthDay: null,
      todayCreditedExp: 0,
      todayCreditedBond: 0,
      nature: "Brave",
      iv: [1, 2, 3, 4, 5, 6],
      characteristic: "Likes to run",
    }),
  );

  const state = await runOneTick({
    usage: {
      ok: true,
      p5h: 12,
      pweek: 34,
      todayCost: 1,
      todayTokens: 1_000,
      modelled: true,
      weekTokens: 5_000,
      activeDays: [
        "2026-05-26",
        "2026-05-27",
        "2026-05-28",
        "2026-05-29",
        "2026-05-30",
        "2026-05-31",
      ],
    },
    weather: sampleWeather(),
    room: { t: 23.4, h: 56 },
    statePath,
    framePath,
    mock: createMockTransport({ framePath }),
    today: "2026-05-31",
  });

  // window 05-28..05-30 all active -> streak +3 (settleDays only); bond not decayed.
  // applyDailyGrowth then adds firstEver bond +4 (1000 tokens) -> bond 104.
  assert.equal(state.streak, 8);
  assert.equal(state.bond, 104);
});

test("genuine inactive day within ccusage range still decays", async () => {
  const statePath = join("out", "test-h1-inactive-state.json");
  const framePath = join("out", "test-h1-inactive-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(framePath, { force: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: 1,
      hatched: true,
      species: "eevee",
      level: 1,
      exp: 0,
      bond: 100,
      streak: 5,
      shield: 0,
      lastSettled: "2026-05-27",
      lastGrowthDay: null,
      todayCreditedExp: 0,
      todayCreditedBond: 0,
      nature: "Brave",
      iv: [1, 2, 3, 4, 5, 6],
      characteristic: "Likes to run",
    }),
  );

  const state = await runOneTick({
    usage: {
      ok: true,
      p5h: 12,
      pweek: 34,
      todayCost: 1,
      todayTokens: 0,
      modelled: true,
      weekTokens: 0,
      activeDays: ["2026-05-27", "2026-05-28", "2026-05-30", "2026-05-31"],
    },
    weather: sampleWeather(),
    room: { t: 23.4, h: 56 },
    statePath,
    framePath,
    mock: createMockTransport({ framePath }),
    today: "2026-05-31",
  });

  // 05-28 used (+1), 05-29 absent -> streak reset to 0 + bond -3, 05-30 used (+1).
  // todayTokens 0 -> no growth bond change.
  assert.equal(state.streak, 1);
  assert.equal(state.bond, 97);
});

test("render model carries the pet's streak from state, not a missing field", async () => {
  const statePath = join("out", "test-model-streak-state.json");
  const framePath = join("out", "test-model-streak-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(framePath, { force: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: 1,
      hatched: true,
      species: "eevee",
      level: 1,
      exp: 0,
      bond: 0,
      streak: 5,
      shield: 0,
      lastSettled: "2026-05-30",
      lastGrowthDay: "2026-05-30",
      todayCreditedExp: 0,
      todayCreditedBond: 0,
      nature: "Brave",
      iv: [1, 2, 3, 4, 5, 6],
      characteristic: "Likes to run",
    }),
  );

  const models = [];
  await runOneTick({
    usage: usageWithTokens(0),
    weather: sampleWeather(),
    room: { t: 23.4, h: 56 },
    statePath,
    framePath,
    mock: createMockTransport({ framePath }),
    today: "2026-05-30",
    onRenderModel: (m) => models.push(m),
  });

  // lastSettled === today => settlement window empty => streak unchanged at 5.
  assert.equal(models[0].streak, 5);
});

test("a buffered KEY-short press evolves a ready pet (H4 between-tick presses)", async () => {
  const statePath = join("out", "test-h4-buffered-key-state.json");
  const framePath = join("out", "test-h4-buffered-key-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(framePath, { force: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: 1, hatched: true, species: "eevee", level: 1, exp: 0,
      bond: 160, streak: 0, shield: 0, lastSettled: "2026-05-30", lastGrowthDay: "2026-05-30",
      todayCreditedExp: 0, todayCreditedBond: 0, readyToEvolve: true,
      nature: "Brave", iv: [1, 2, 3, 4, 5, 6], characteristic: "Likes to run",
    }),
  );

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: sampleWeather(),
    room: { t: 21, h: 45 },
    statePath,
    framePath,
    mock: createMockTransport({ framePath }),
    now: new Date(2026, 4, 30, 21), // night -> eevee auto-evolves to umbreon
    today: "2026-05-30",
    pendingButtons: [{ key: "KEY", kind: "short" }],
    evolutionDelay: async () => {},
  });

  assert.equal(state.species, "umbreon");
  assert.equal(state.readyToEvolve, false);
});

test("growth is not credited from a ccusage day that isn't today (L3)", async () => {
  const statePath = join("out", "test-l3-period-state.json");
  const framePath = join("out", "test-l3-period-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(framePath, { force: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: 1, hatched: true, species: "eevee", level: 1, exp: 0,
      bond: 0, streak: 0, shield: 0, lastSettled: "2026-05-29", lastGrowthDay: "2026-05-29",
      todayCreditedExp: 0, todayCreditedBond: 0,
      nature: "Brave", iv: [1, 2, 3, 4, 5, 6], characteristic: "Likes to run",
    }),
  );

  const state = await runOneTick({
    usage: { ...usageWithTokens(5_000), todayPeriod: "2026-05-29" }, // ccusage's latest day is yesterday
    weather: sampleWeather(),
    room: { t: 23.4, h: 56 },
    statePath,
    framePath,
    mock: createMockTransport({ framePath }),
    today: "2026-05-30",
  });

  // yesterday's 5000 tokens must NOT be credited to today
  assert.equal(state.expGain, 0);
});

test("a KEY long-press records care so care-gated evolutions become reachable (M7)", async () => {
  const statePath = join("out", "test-m7-care-state.json");
  const framePath = join("out", "test-m7-care-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(framePath, { force: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: 1, hatched: true, species: "eevee", level: 1, exp: 0,
      bond: 160, streak: 0, shield: 0, lastSettled: "2026-05-30", lastGrowthDay: "2026-05-30",
      todayCreditedExp: 0, todayCreditedBond: 0,
      nature: "Brave", iv: [1, 2, 3, 4, 5, 6], characteristic: "Likes to run",
    }),
  );

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: sampleWeather(),
    room: { t: 23.4, h: 56 },
    statePath,
    framePath,
    mock: createMockTransport({ framePath }),
    now: new Date(2026, 4, 30, 10), // daytime
    today: "2026-05-30",
    pendingButtons: [{ key: "KEY", kind: "long" }],
    evolutionDelay: async () => {},
  });

  // care recorded, and a long-press does NOT itself evolve
  assert.equal(state.careCount, 1);
  assert.equal(state.species, "eevee");
});

function usageWithTokens(todayTokens) {
  return {
    p5h: 12,
    pweek: 34,
    todayCost: 1,
    todayTokens,
    modelled: true,
    weekTokens: todayTokens,
  };
}

function sampleWeather() {
  return {
    cond: "多云",
    temp: 19,
    feels: 17,
    hi: 22,
    lo: 14,
    precip: 30,
    wind: 11,
    humidity: 64,
  };
}

function personalityOf(pet) {
  return {
    nature: pet.nature,
    iv: pet.iv,
    characteristic: pet.characteristic,
  };
}

function sequenceRng(values) {
  let index = 0;
  return () => values[index++];
}
