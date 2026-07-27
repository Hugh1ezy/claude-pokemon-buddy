import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { runOneTick } from "../src/index.js";
import { createMockTransport } from "../src/transport/mock.js";

test("bond threshold marks ready without auto-evolving species", async () => {
  const statePath = join("out", "test-ready-evolve-state.json");
  const framePath = join("out", "test-ready-evolve-frame.png");
  writeState(statePath, { bond: 160 });

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: weather({ temp: 12, humidity: 50 }),
    room: { t: 21, h: 45 },
    statePath,
    framePath,
    now: new Date(2026, 4, 30, 10),
    mock: createMockTransport({ framePath }),
  });

  assert.equal(state.species, "eevee");
  assert.equal(state.readyToEvolve, true);
  assert.equal(state.pendingCandidates, undefined);
});

test("night RTC plus KEY evolves ready Eevee to Umbreon", async () => {
  const statePath = join("out", "test-key-umbreon-state.json");
  const framePath = join("out", "test-key-umbreon-frame.png");
  writeState(statePath, { bond: 160, readyToEvolve: true });

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: weather({ temp: 12, humidity: 50 }),
    statePath,
    framePath,
    now: new Date(2026, 4, 30, 21),
    mock: createMockTransport({ framePath }),
    pendingButtons: [{ key: "KEY", kind: "short" }],
    evolutionDelay: async () => {},
  });

  assert.equal(state.species, "umbreon");
  assert.equal(state.readyToEvolve, false);
  assert.equal(state.pendingCandidates, undefined);
});

test("long-press KEY does not trigger evolution (short-only)", async () => {
  const statePath = join("out", "test-key-long-noevolve-state.json");
  const framePath = join("out", "test-key-long-noevolve-frame.png");
  writeState(statePath, { bond: 160, readyToEvolve: true });

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: weather({ temp: 12, humidity: 50 }),
    statePath,
    framePath,
    now: new Date(2026, 4, 30, 21),
    mock: createMockTransport({ framePath, sensor: { t: 21, h: 45 } }),
    pendingButtons: [{ key: "KEY", kind: "long" }],
    evolutionDelay: async () => {},
  });

  assert.equal(state.species, "eevee");
  assert.equal(state.readyToEvolve, true);
  assert.equal(state.careCount, 1);
  assert.equal(state.pendingCandidates, undefined);
});

test("double-press KEY does not trigger evolution (short-only)", async () => {
  const statePath = join("out", "test-key-double-noevolve-state.json");
  const framePath = join("out", "test-key-double-noevolve-frame.png");
  writeState(statePath, { bond: 160, readyToEvolve: true });

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: weather({ temp: 12, humidity: 50 }),
    statePath,
    framePath,
    now: new Date(2026, 4, 30, 21),
    mock: createMockTransport({ framePath, sensor: { t: 21, h: 45 } }),
    pendingButtons: [{ key: "KEY", kind: "double" }],
    evolutionDelay: async () => {},
  });

  assert.equal(state.species, "eevee");
  assert.equal(state.readyToEvolve, true);
  assert.equal(state.pendingCandidates, undefined);
});

test("multi-candidate readiness stores pending candidates as choice prompt state", async () => {
  const statePath = join("out", "test-pending-evolve-state.json");
  const framePath = join("out", "test-pending-evolve-frame.png");
  writeState(statePath, { bond: 160, readyToEvolve: true, careCount: 0 });

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: weather({ temp: 24, humidity: 70 }),
    statePath,
    framePath,
    now: new Date(2026, 4, 30, 10),
    mock: createMockTransport({ framePath, sensor: { t: 24, h: 70 } }),
  });

  assert.equal(state.species, "eevee");
  assert.equal(state.readyToEvolve, true);
  assert.deepEqual(state.pendingCandidates.map(({ to }) => to), [
    "espeon",
    "leafeon",
  ]);
});

test("single-candidate auto readiness strips stale pending candidates", async () => {
  const statePath = join("out", "test-single-auto-strip-pending-state.json");
  const framePath = join("out", "test-single-auto-strip-pending-frame.png");
  writeState(statePath, {
    species: "bulbasaur",
    level: 16,
    bond: 0,
    readyToEvolve: true,
    pendingCandidates: [
      { to: "espeon", needs: { bond: 56, daytime: true }, priority: 2 },
      { to: "leafeon", needs: { bond: 56, warmHumid: true }, priority: 3 },
    ],
  });

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: weather({ temp: 12, humidity: 50 }),
    statePath,
    framePath,
    now: new Date(2026, 4, 30, 10),
    mock: createMockTransport({ framePath }),
  });

  assert.equal(state.species, "bulbasaur");
  assert.equal(state.readyToEvolve, true);
  assert.equal(state.pendingCandidates, undefined);
});

test("queued choice intent evolves a currently eligible pending branch on the next tick", async () => {
  const statePath = join("out", "test-choice-leafeon-state.json");
  const framePath = join("out", "test-choice-leafeon-frame.png");
  writeState(statePath, {
    bond: 160,
    readyToEvolve: true,
    pendingCandidates: [
      { to: "espeon", needs: { bond: 56, daytime: true }, priority: 2 },
      { to: "leafeon", needs: { bond: 56, warmHumid: true }, priority: 3 },
    ],
  });
  const evolutionIntents = intentQueue([{ type: "choose", to: "leafeon" }]);

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: weather({ temp: 24, humidity: 70 }),
    statePath,
    framePath,
    now: new Date(2026, 4, 30, 10),
    mock: createMockTransport({ framePath, sensor: { t: 24, h: 70 } }),
    evolutionIntents,
    evolutionDelay: async () => {},
  });

  assert.equal(state.species, "leafeon");
  assert.equal(state.readyToEvolve, false);
  assert.equal(state.pendingCandidates, undefined);
});

test("stone overrides RTC branch when KEY triggers evolution", async () => {
  const statePath = join("out", "test-stone-evolve-state.json");
  const framePath = join("out", "test-stone-evolve-frame.png");
  writeState(statePath, { bond: 160, readyToEvolve: true, stone: "fire" });

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: weather({ temp: 12, humidity: 50 }),
    statePath,
    framePath,
    now: new Date(2026, 4, 30, 10),
    mock: createMockTransport({ framePath }),
    pendingButtons: [{ key: "KEY", kind: "short" }],
    evolutionDelay: async () => {},
  });

  assert.equal(state.species, "flareon");
  assert.equal(state.stone, undefined);
  assert.equal(state.readyToEvolve, false);
});

test("starter reaching its level threshold is ready (table-driven, not bond)", async () => {
  const statePath = join("out", "test-bulba-ready-state.json");
  const framePath = join("out", "test-bulba-ready-frame.png");
  writeState(statePath, { species: "bulbasaur", level: 16, bond: 0 });

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: weather({ temp: 12, humidity: 50 }),
    statePath,
    framePath,
    now: new Date(2026, 4, 30, 10),
    mock: createMockTransport({ framePath }),
  });

  assert.equal(state.species, "bulbasaur");
  assert.equal(state.readyToEvolve, true);
});

test("KEY evolves a level-ready Bulbasaur to Ivysaur", async () => {
  const statePath = join("out", "test-bulba-evolve-state.json");
  const framePath = join("out", "test-bulba-evolve-frame.png");
  writeState(statePath, { species: "bulbasaur", level: 16, bond: 0 });

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: weather({ temp: 12, humidity: 50 }),
    statePath,
    framePath,
    now: new Date(2026, 4, 30, 10),
    mock: createMockTransport({ framePath }),
    pendingButtons: [{ key: "KEY", kind: "short" }],
    evolutionDelay: async () => {},
  });

  assert.equal(state.species, "ivysaur");
  assert.equal(state.readyToEvolve, false);
});

test("high bond below the level threshold is NOT ready (dead-window regression)", async () => {
  // Under the old bond>=56 trigger, an Ivysaur with bond 100 would falsely show
  // readyToEvolve until level 30. Table-driven resolution must recompute false.
  const statePath = join("out", "test-ivy-deadwindow-state.json");
  const framePath = join("out", "test-ivy-deadwindow-frame.png");
  writeState(statePath, { species: "ivysaur", level: 20, bond: 100, readyToEvolve: true });

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: weather({ temp: 12, humidity: 50 }),
    statePath,
    framePath,
    now: new Date(2026, 4, 30, 10),
    mock: createMockTransport({ framePath }),
  });

  assert.equal(state.species, "ivysaur");
  assert.equal(state.readyToEvolve, false);
});

test("KEY evolves a level-32 Ivysaur to Venusaur", async () => {
  const statePath = join("out", "test-ivy-evolve-state.json");
  const framePath = join("out", "test-ivy-evolve-frame.png");
  writeState(statePath, { species: "ivysaur", level: 32, bond: 0 });

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: weather({ temp: 12, humidity: 50 }),
    statePath,
    framePath,
    now: new Date(2026, 4, 30, 10),
    mock: createMockTransport({ framePath }),
    pendingButtons: [{ key: "KEY", kind: "short" }],
    evolutionDelay: async () => {},
  });

  assert.equal(state.species, "venusaur");
  assert.equal(state.readyToEvolve, false);
});

test("KEY evolution saves evolved state and pushes the animation", async () => {
  const statePath = join("out", "test-evo-anim-state.json");
  const framePath = join("out", "test-evo-anim-frame.png");
  writeState(statePath, { species: "eevee", bond: 160, readyToEvolve: true });
  const mock = createMockTransport({ framePath });
  const origPush = mock.push.bind(mock);
  let pushes = 0;
  mock.push = async (frame) => {
    pushes += 1;
    return origPush(frame);
  };

  const state = await runOneTick({
    usage: usageWithTokens(0),
    weather: weather({ temp: 12, humidity: 50 }),
    statePath,
    framePath,
    now: new Date(2026, 4, 30, 21),
    mock,
    pendingButtons: [{ key: "KEY", kind: "short" }],
    evolutionDelay: async () => {},
  });

  assert.equal(state.species, "umbreon");
  const persisted = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(persisted.species, "umbreon");
  assert.ok(pushes > 1, "animation frames plus final daily frame must be pushed");
});

function writeState(statePath, overrides) {
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: 1,
      hatched: true,
      species: "eevee",
      level: 1,
      exp: 0,
      bond: 120,
      streak: 0,
      shield: 0,
      lastSettled: "2026-05-29",
      lastGrowthDay: "2026-05-30",
      todayCreditedExp: 0,
      todayCreditedBond: 0,
      ...overrides,
    }),
  );
}

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

function weather({ temp, humidity }) {
  return {
    cond: "澶氫簯",
    temp,
    feels: temp,
    hi: temp + 2,
    lo: temp - 2,
    precip: 30,
    wind: 11,
    humidity,
  };
}

function intentQueue(initial = []) {
  const items = [...initial];
  return {
    push(intent) {
      items.push(intent);
    },
    drain() {
      return items.splice(0);
    },
  };
}
