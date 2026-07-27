import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";

import { createButtonDispatcher, main, runOneTick, runTickLoop } from "../src/index.js";
import { OAK_LINES } from "../src/pet/onboarding-data.js";
import { SOUND } from "../src/transport/proto.js";

const blocksJson = readFileSync(new URL("./fixtures/ccusage-blocks.json", import.meta.url), "utf8");
const dailyJson = readFileSync(new URL("./fixtures/ccusage-daily.json", import.meta.url), "utf8");

test("runTickLoop runs the first tick, survives a throwing tick, and stops when asked (H5)", async () => {
  const calls = [];
  let n = 0;
  let started = false;
  await runTickLoop({
    runTick: async () => {
      n += 1;
      calls.push(n);
      if (n === 2) throw new Error("boom"); // a failing tick must NOT kill the loop
    },
    intervalMs: 0,
    isStopped: () => n >= 3,
    beforeLoop: () => { started = true; },
    setTimer: (resolve) => resolve(), // no real delay
    onError: () => {}, // swallow the expected throw quietly in the test
  });

  assert.deepEqual(calls, [1, 2, 3]); // tick 2 threw but the loop continued to tick 3
  assert.equal(started, true); // beforeLoop ran after the first tick
});

function createBitmapMockTransport({
  buttonsOnSubscribe = [],
  onPush = () => {},
  onClose = () => {},
  onPlaySound = () => {},
  onSendVolume = () => {},
} = {}) {
  const emitter = new EventEmitter();
  return {
    onButton(callback) {
      emitter.on("button", callback);
      for (const b of buttonsOnSubscribe) callback(b); // deliver pre-arrived presses on subscribe
      return () => emitter.off("button", callback);
    },
    async push(frame) {
      await onPush(frame);
      return { ok: true };
    },
    feedSensor() {
      return { t: 23, h: 56 };
    },
    playSound(id) { onPlaySound(id); },
    setActiveCry() {},
    sendVolume(volume) { onSendVolume(volume); },
    close() { onClose(); },
  };
}

test("main resolves when SIGINT stops the loop during its sleep (RH2)", async () => {
  mkdirSync("out", { recursive: true });
  const statePath = join("out", "test-main-rh2-state.json");
  const framePath = join("out", "test-main-rh2-frame.png");
  const configPath = join("out", "test-main-rh2-config.json");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(configPath, { force: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: 1,
      hatched: true,
      species: "eevee",
      level: 1,
      exp: 0,
      bond: 0,
      streak: 0,
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

  let closed = false;
  let pushed = 0;
  const running = main({
    once: false,
    intervalMs: 60_000,
    dashboard: false,
    statePath,
    framePath,
    configPath,
    // This test counts pushes as ticks to decide when to stop. The cold-start
    // repaint is a push that is not a tick, so it has to be off here or the
    // stop fires against the wrong frame.
    firstPaint: false,
    transport: createBitmapMockTransport({
      onPush: () => {
        pushed += 1;
        if (pushed === 1) setImmediate(() => process.emit("SIGINT"));
      },
      onClose: () => { closed = true; },
    }),
    weatherClient: {
      get: async () => ({ cond: "多云", temp: 19, feels: 17, hi: 22, lo: 14, precip: 30, wind: 11, humidity: 64, degraded: false }),
    },
    pollUsage: async () => ({ ok: true, skipped: true }),
    usageRun: async (_command, args) => (args.includes("daily") ? dailyJson : blocksJson),
  });

  const result = await Promise.race([
    running.then(() => "settled"),
    sleep(50).then(() => "timeout"),
  ]);

  assert.equal(result, "settled");
  assert.equal(closed, true);
});

test("main logs pollUsage failures once per reason transition", async () => {
  mkdirSync("out", { recursive: true });
  const statePath = join("out", "test-main-rl6-state.json");
  const framePath = join("out", "test-main-rl6-frame.png");
  const configPath = join("out", "test-main-rl6-config.json");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(configPath, { force: true });
  writeState(statePath);

  const pollResults = [
    { ok: false, reason: "no-token" },
    { ok: false, reason: "no-token" },
    { ok: false, reason: "fetch-failed" },
    { ok: false, reason: "fetch-failed" },
    { ok: true, skipped: true },
    { ok: false, reason: "fetch-failed" },
  ];
  let pollCalls = 0;
  const warnings = [];
  const running = main({
    once: false,
    intervalMs: 0,
    dashboard: false,
    statePath,
    framePath,
    configPath,
    firstPaint: false,   // pushes are counted as ticks here
    transport: createBitmapMockTransport({
      onPush: () => {
        if (pollCalls >= pollResults.length) process.emit("SIGINT");
      },
    }),
    weatherClient: {
      get: async () => ({ cond: "多云", temp: 19, feels: 17, hi: 22, lo: 14, precip: 30, wind: 11, humidity: 64, degraded: false }),
    },
    pollUsage: async () => pollResults[pollCalls++] ?? { ok: true, skipped: true },
    usageRun: async (_command, args) => (args.includes("daily") ? dailyJson : blocksJson),
    logger: { warn: (message) => warnings.push(String(message)) },
  });

  const result = await Promise.race([
    running.then(() => "settled"),
    sleep(500).then(() => "timeout"),
  ]);

  assert.equal(result, "settled");
  assert.deepEqual(warnings, [
    "pollUsage failed: no-token",
    "pollUsage failed: fetch-failed",
    "pollUsage failed: fetch-failed",
  ]);
});

test("main logs loadUsageSnapshot failures once per reason transition", async () => {
  mkdirSync("out", { recursive: true });
  const statePath = join("out", "test-main-ar6-usage-state.json");
  const framePath = join("out", "test-main-ar6-usage-frame.png");
  const configPath = join("out", "test-main-ar6-usage-config.json");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(configPath, { force: true });
  writeState(statePath);

  const usageResults = [
    "schema drift",
    "schema drift",
    "ccusage unavailable",
    "ccusage unavailable",
    null,
    "ccusage unavailable",
  ];
  let usageTicks = 0;
  const warnings = [];
  const running = main({
    once: false,
    intervalMs: 0,
    dashboard: false,
    statePath,
    framePath,
    configPath,
    firstPaint: false,   // pushes are counted as ticks here
    transport: createBitmapMockTransport({
      onPush: () => {
        if (usageTicks >= usageResults.length) process.emit("SIGINT");
      },
    }),
    weatherClient: {
      get: async () => ({ cond: "多云", temp: 19, feels: 17, hi: 22, lo: 14, precip: 30, wind: 11, humidity: 64, degraded: false }),
    },
    pollUsage: async () => ({ ok: true, skipped: true }),
    usageRun: async (_command, args) => {
      if (args.includes("daily")) return dailyJson;
      const result = usageResults[usageTicks++];
      if (result) throw new Error(result);
      return blocksJson;
    },
    logger: { warn: (message) => warnings.push(String(message)) },
  });

  const result = await Promise.race([
    running.then(() => "settled"),
    sleep(500).then(() => "timeout"),
  ]);

  assert.equal(result, "settled");
  assert.deepEqual(warnings, [
    "loadUsageSnapshot failed: schema drift",
    "loadUsageSnapshot failed: ccusage unavailable",
    "loadUsageSnapshot failed: ccusage unavailable",
  ]);
});

test("a button that arrived before the tick is buffered and drained into the tick (H4 via main once-mode)", async () => {
  mkdirSync("out", { recursive: true });
  const statePath = join("out", "test-main-h4-state.json");
  const framePath = join("out", "test-main-h4-frame.png");
  const configPath = join("out", "test-main-h4-config.json");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(configPath, { force: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: 1,
      hatched: true,
      species: "eevee",
      level: 1,
      exp: 0,
      bond: 0,
      streak: 0,
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

  await main({
    once: true,
    dashboard: false,
    statePath,
    framePath,
    configPath,
    transport: createBitmapMockTransport({ buttonsOnSubscribe: [{ key: "KEY", kind: "long" }] }),
    weatherClient: {
      get: async () => ({ cond: "多云", temp: 19, feels: 17, hi: 22, lo: 14, precip: 30, wind: 11, humidity: 64, degraded: false }),
    },
    pollUsage: async () => ({ ok: true, skipped: true }),
    usageRun: async (_command, args) => (args.includes("daily") ? dailyJson : blocksJson),
  });

  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.careCount, 1); // buffered KEY-long was drained into runOneTick -> care recorded
});

test("main once-mode closes transport before resolving (RM13)", async () => {
  mkdirSync("out", { recursive: true });
  const statePath = join("out", "test-main-rm13-state.json");
  const framePath = join("out", "test-main-rm13-frame.png");
  const configPath = join("out", "test-main-rm13-config.json");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(configPath, { force: true });
  writeState(statePath);
  writeConfig(configPath);

  let closed = false;
  await main({
    once: true,
    dashboard: false,
    statePath,
    framePath,
    configPath,
    transport: createBitmapMockTransport({ onClose: () => { closed = true; } }),
    weatherClient: {
      get: async () => ({ cond: "多云", temp: 19, feels: 17, hi: 22, lo: 14, precip: 30, wind: 11, humidity: 64, degraded: false }),
    },
    pollUsage: async () => ({ ok: true, skipped: true }),
    usageRun: async (_command, args) => (args.includes("daily") ? dailyJson : blocksJson),
  });

  assert.equal(closed, true);
});

test("main closes transport when dashboard startup rejects (R1)", async () => {
  mkdirSync("out", { recursive: true });
  const statePath = join("out", "test-main-r1-startup-failure-state.json");
  const framePath = join("out", "test-main-r1-startup-failure-frame.png");
  const configPath = join("out", "test-main-r1-startup-failure-config.json");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(configPath, { force: true });
  writeState(statePath);
  writeConfig(configPath);

  const occupied = createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  const address = occupied.address();
  let closeCalls = 0;
  try {
    await assert.rejects(
      main({
        once: false,
        dashboard: true,
        dashboardHost: "127.0.0.1",
        dashboardPort: address.port,
        statePath,
        framePath,
        configPath,
        transport: createBitmapMockTransport({
          onClose: () => { closeCalls += 1; },
        }),
        weatherClient: {
          get: async () => ({ cond: "多云", temp: 19, feels: 17, hi: 22, lo: 14, precip: 30, wind: 11, humidity: 64, degraded: false }),
        },
        pollUsage: async () => ({ ok: true, skipped: true }),
        usageRun: async (_command, args) => (args.includes("daily") ? dailyJson : blocksJson),
      }),
      (error) => error?.code === "EADDRINUSE",
    );
    assert.equal(closeCalls, 1);
  } finally {
    await new Promise((resolve, reject) => {
      occupied.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("quietHours gate host top-of-hour sounds across midnight (RM12)", async () => {
  const muted = await runMainOnceWithClock({
    suffix: "rm12-muted",
    config: { quietHours: { start: 22, end: 8 }, volume: 70 },
    times: [
      new Date(2026, 0, 1, 1, 59),
      new Date(2026, 0, 1, 2, 0),
    ],
  });
  assert.deepEqual(muted.sounds, []);

  const audible = await runMainOnceWithClock({
    suffix: "rm12-audible",
    config: { quietHours: { start: 23, end: 7 }, volume: 70 },
    times: [
      new Date(2026, 0, 1, 6, 59),
      new Date(2026, 0, 1, 7, 1),
    ],
  });
  assert.deepEqual(audible.sounds, [SOUND.HOUR]);
});

test("quiet boundary sends VOLUME 0 on entry and restores configured volume on exit (RM12)", async () => {
  mkdirSync("out", { recursive: true });
  const statePath = join("out", "test-main-rm12-volume-boundary-state.json");
  const framePath = join("out", "test-main-rm12-volume-boundary-frame.png");
  const configPath = join("out", "test-main-rm12-volume-boundary-config.json");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(configPath, { force: true });
  writeState(statePath);
  writeConfig(configPath, { quietHours: { start: 22, end: 7 }, volume: 55 });

  const volumes = [];
  let pushes = 0;
  const running = main({
    once: false,
    intervalMs: 0,
    dashboard: false,
    statePath,
    framePath,
    configPath,
    nowProvider: sequenceClock([
      new Date(2026, 0, 1, 21, 59),
      new Date(2026, 0, 1, 22, 0),
      new Date(2026, 0, 2, 7, 1),
    ]),
    firstPaint: false,   // pushes are counted as ticks here
    transport: createBitmapMockTransport({
      onSendVolume: (volume) => volumes.push(volume),
      onPush: () => {
        pushes += 1;
        if (pushes >= 2) process.emit("SIGINT");
      },
    }),
    weatherClient: {
      get: async () => ({ cond: "多云", temp: 19, feels: 17, hi: 22, lo: 14, precip: 30, wind: 11, humidity: 64, degraded: false }),
    },
    pollUsage: async () => ({ ok: true, skipped: true }),
    usageRun: async (_command, args) => (args.includes("daily") ? dailyJson : blocksJson),
  });

  const result = await Promise.race([
    running.then(() => "settled"),
    sleep(500).then(() => "timeout"),
  ]);

  assert.equal(result, "settled");
  assert.deepEqual(volumes, [55, 0, 55]);
});

test("button emitted while runOneTick is active is routed to the next tick exactly once (RH3)", async () => {
  mkdirSync("out", { recursive: true });
  const statePath = join("out", "test-rh3-midtick-state.json");
  const framePath = join("out", "test-rh3-midtick-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  writeState(statePath, { species: "bulbasaur", level: 30, bond: 0 });

  const transport = createButtonEventTransport({
    onFeedSensor: ({ calls, transport }) => {
      if (calls === 1) transport.emitButton({ key: "KEY", kind: "short" });
    },
  });
  let runtimePet;
  const dispatcher = createButtonDispatcher({
    transport,
    getPet: () => runtimePet,
  });

  runtimePet = await runOneTick({
    usage: usageWithTokens(0),
    weather: sampleWeather(),
    statePath,
    framePath,
    transport,
    pendingButtons: dispatcher.drainTickEvents(),
    today: "2026-05-30",
    now: new Date(2026, 4, 30, 10),
    evolutionDelay: async () => {},
  });
  assert.equal(runtimePet.species, "bulbasaur");

  runtimePet = await runOneTick({
    usage: usageWithTokens(0),
    weather: sampleWeather(),
    statePath,
    framePath,
    transport,
    pendingButtons: dispatcher.drainTickEvents(),
    today: "2026-05-30",
    now: new Date(2026, 4, 30, 10),
    evolutionDelay: async () => {},
  });
  assert.equal(runtimePet.species, "ivysaur");

  runtimePet = await runOneTick({
    usage: usageWithTokens(0),
    weather: sampleWeather(),
    statePath,
    framePath,
    transport,
    pendingButtons: dispatcher.drainTickEvents(),
    today: "2026-05-30",
    now: new Date(2026, 4, 30, 10),
    evolutionDelay: async () => {},
  });
  assert.equal(runtimePet.species, "ivysaur");
  assert.equal(transport.maxListenerCount(), 1);
  dispatcher.stop();
});

test("failed tick drains requeue once and do not leak button listeners (RH3)", async () => {
  mkdirSync("out", { recursive: true });
  const statePath = join("out", "test-rh3-requeue-state.json");
  const framePath = join("out", "test-rh3-requeue-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  writeState(statePath, { species: "eevee", bond: 0 });

  const transport = createButtonEventTransport({
    onFeedSensor: ({ calls }) => {
      if (calls === 1) throw new Error("sensor failed");
    },
  });
  const dispatcher = createButtonDispatcher({ transport });
  transport.emitButton({ key: "KEY", kind: "long" });

  const firstDrain = dispatcher.drainTickEvents();
  await assert.rejects(
    runOneTick({
      usage: usageWithTokens(0),
      weather: sampleWeather(),
      statePath,
      framePath,
      transport,
      pendingButtons: firstDrain,
      today: "2026-05-30",
    }),
    /sensor failed/,
  );
  assert.equal(dispatcher.requeueForRetry(firstDrain), 1);
  assert.equal(transport.maxListenerCount(), 1);

  const pet = await runOneTick({
    usage: usageWithTokens(0),
    weather: sampleWeather(),
    statePath,
    framePath,
    transport,
    pendingButtons: dispatcher.drainTickEvents(),
    today: "2026-05-30",
  });

  assert.equal(pet.careCount, 1);
  assert.deepEqual(dispatcher.drainTickEvents(), []);
  assert.equal(transport.maxListenerCount(), 1);
  dispatcher.stop();
});

test("onboarding button handling is isolated before the resident dispatcher starts (RH3)", async () => {
  mkdirSync("out", { recursive: true });
  const statePath = join("out", "test-rh3-onboarding-state.json");
  const framePath = join("out", "test-rh3-onboarding-frame.png");
  const configPath = join("out", "test-rh3-onboarding-config.json");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(configPath, { force: true });

  const transport = createOnboardingTransport();
  await main({
    once: true,
    dashboard: false,
    statePath,
    framePath,
    configPath,
    transport,
    weatherClient: {
      get: async () => ({ cond: "多云", temp: 19, feels: 17, hi: 22, lo: 14, precip: 30, wind: 11, humidity: 64, degraded: false }),
    },
    pollUsage: async () => ({ ok: true, skipped: true }),
    usageRun: async (_command, args) => (args.includes("daily") ? dailyJson : blocksJson),
  });

  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.hatched, true);
  assert.equal(state.species, "eevee");
  assert.equal(state.careCount, undefined);
  assert.equal(state.tutorialDone, true);
  assert.equal(transport.maxListenerCount(), 1);
  assert.equal(transport.subscriptionCount(), 3); // onboarding io → tutorial io → resident dispatcher，串行不叠listener
});

test("evolution choice intent submitted during a tick is applied on the next tick without clobbering state", async () => {
  mkdirSync("out", { recursive: true });
  const statePath = join("out", "test-rh1-midtick-intent-state.json");
  const framePath = join("out", "test-rh1-midtick-intent-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  writeState(statePath, {
    species: "eevee",
    bond: 160,
    pendingCandidates: [
      { to: "espeon", needs: { bond: 56, daytime: true }, priority: 2 },
      { to: "leafeon", needs: { bond: 56, warmHumid: true }, priority: 3 },
    ],
  });
  const evolutionIntents = intentQueue();
  const transport = createButtonEventTransport({
    onFeedSensor: ({ calls }) => {
      if (calls === 1) evolutionIntents.push({ type: "choose", to: "leafeon" });
    },
  });

  const first = await runOneTick({
    usage: usageWithTokens(0),
    weather: { ...sampleWeather(), temp: 24, humidity: 70 },
    statePath,
    framePath,
    transport,
    evolutionIntents,
    today: "2026-05-30",
    now: new Date(2026, 4, 30, 10),
    evolutionDelay: async () => {},
  });

  assert.equal(first.species, "eevee");
  assert.deepEqual(first.pendingCandidates.map(({ to }) => to), ["espeon", "leafeon"]);

  const second = await runOneTick({
    usage: usageWithTokens(0),
    weather: { ...sampleWeather(), temp: 24, humidity: 70 },
    statePath,
    framePath,
    transport,
    evolutionIntents,
    today: "2026-05-30",
    now: new Date(2026, 4, 30, 10),
    evolutionDelay: async () => {},
  });

  assert.equal(second.species, "leafeon");
  assert.equal(second.pendingCandidates, undefined);
});

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function writeState(statePath, overrides = {}) {
  writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: 1,
      hatched: true,
      species: "eevee",
      level: 1,
      exp: 0,
      bond: 0,
      streak: 0,
      shield: 0,
      lastSettled: "2026-05-30",
      lastGrowthDay: "2026-05-30",
      todayCreditedExp: 0,
      todayCreditedBond: 0,
      nature: "Brave",
      iv: [1, 2, 3, 4, 5, 6],
      characteristic: "Likes to run",
      ...overrides,
    }),
  );
}

function writeConfig(configPath, overrides = {}) {
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "阿布",
      quietHours: { start: 22, end: 8 },
      volume: 70,
      lat: -36.8485,
      lon: 174.7633,
      ...overrides,
    }),
  );
}

async function runMainOnceWithClock({ suffix, config, times }) {
  mkdirSync("out", { recursive: true });
  const statePath = join("out", `test-main-${suffix}-state.json`);
  const framePath = join("out", `test-main-${suffix}-frame.png`);
  const configPath = join("out", `test-main-${suffix}-config.json`);
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(configPath, { force: true });
  writeState(statePath);
  writeConfig(configPath, config);

  const sounds = [];
  await main({
    once: true,
    dashboard: false,
    statePath,
    framePath,
    configPath,
    nowProvider: sequenceClock(times),
    transport: createBitmapMockTransport({ onPlaySound: (id) => sounds.push(id) }),
    weatherClient: {
      get: async () => ({ cond: "多云", temp: 19, feels: 17, hi: 22, lo: 14, precip: 30, wind: 11, humidity: 64, degraded: false }),
    },
    pollUsage: async () => ({ ok: true, skipped: true }),
    usageRun: async (_command, args) => (args.includes("daily") ? dailyJson : blocksJson),
  });

  return { sounds };
}

function sequenceClock(times) {
  let index = 0;
  return () => {
    const value = times[Math.min(index, times.length - 1)];
    index += 1;
    return value;
  };
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

function createButtonEventTransport({ onFeedSensor = () => {} } = {}) {
  const emitter = new EventEmitter();
  let feedCalls = 0;
  let maxListeners = 0;
  const updateMaxListeners = () => {
    maxListeners = Math.max(maxListeners, emitter.listenerCount("button"));
  };
  const transport = {
    onButton(callback) {
      emitter.on("button", callback);
      updateMaxListeners();
      return () => {
        emitter.off("button", callback);
        updateMaxListeners();
      };
    },
    emitButton(event) {
      emitter.emit("button", event);
    },
    async push() {
      return { ok: true };
    },
    feedSensor() {
      feedCalls += 1;
      onFeedSensor({ calls: feedCalls, transport });
      updateMaxListeners();
      return { t: 23, h: 56 };
    },
    playSound() {},
    setActiveCry() {},
    maxListenerCount() {
      return maxListeners;
    },
  };
  return transport;
}

function createOnboardingTransport() {
  const emitter = new EventEmitter();
  let subscriptions = 0;
  let pushes = 0;
  let maxListeners = 0;
  const updateMaxListeners = () => {
    maxListeners = Math.max(maxListeners, emitter.listenerCount("button"));
  };
  const emitAfterPush = (event) => setImmediate(() => emitter.emit("button", event));
  return {
    onButton(callback) {
      subscriptions += 1;
      emitter.on("button", callback);
      updateMaxListeners();
      return () => {
        emitter.off("button", callback);
        updateMaxListeners();
      };
    },
    async push() {
      pushes += 1;
      if (pushes <= OAK_LINES.length) {
        emitAfterPush({ key: "KEY", kind: "short" });
      } else if (pushes === OAK_LINES.length + 1) {
        emitAfterPush({ key: "KEY", kind: "long" });
      } else if (pushes === OAK_LINES.length + 14) {
        emitAfterPush({ key: "KEY", kind: "short" });
      } else if (pushes === OAK_LINES.length + 15) {
        emitAfterPush({ key: "KEY", kind: "long" }); // 教程首屏：长按跳过全部
      }
      return { ok: true };
    },
    feedSensor() {
      return { t: 23, h: 56 };
    },
    playSound() {},
    setActiveCry() {},
    close() {},
    maxListenerCount() {
      return maxListeners;
    },
    subscriptionCount() {
      return subscriptions;
    },
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
