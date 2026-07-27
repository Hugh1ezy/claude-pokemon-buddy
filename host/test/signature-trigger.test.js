import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  shouldPlaySignature,
  shouldQueueButtonForTick,
  createActionQueue,
  createButtonDispatcher,
  runOneTick,
} from "../src/index.js";
import { applyBondTick, heartsFromHalves } from "../src/pet/bond.js";

test("KEY short on a non-evolving pet triggers signature", () => {
  assert.equal(shouldPlaySignature({ key: "KEY", kind: "short" }, { readyToEvolve: false }), true);
});

test("readyToEvolve pet does NOT trigger signature (evolution owns KEY)", () => {
  assert.equal(shouldPlaySignature({ key: "KEY", kind: "short" }, { readyToEvolve: true }), false);
});

test("long/double/boot presses do not trigger signature", () => {
  assert.equal(shouldPlaySignature({ key: "KEY", kind: "long" }, { readyToEvolve: false }), false);
  assert.equal(shouldPlaySignature({ key: "KEY", kind: "double" }, { readyToEvolve: false }), false);
  assert.equal(shouldPlaySignature({ key: "BOOT", kind: "short" }, { readyToEvolve: false }), false);
});

test("tick queue accepts KEY short/long/double and ignores unrelated buttons", () => {
  assert.equal(shouldQueueButtonForTick({ key: "KEY", kind: "short" }), true);
  assert.equal(shouldQueueButtonForTick({ key: "KEY", kind: "long" }), true);
  assert.equal(shouldQueueButtonForTick({ key: "KEY", kind: "double" }), true);
  assert.equal(shouldQueueButtonForTick({ key: "BOOT", kind: "short" }), false);
});

test("missing pet/event is safe (no trigger)", () => {
  assert.equal(shouldPlaySignature(undefined, undefined), false);                 // undefined!==false
  assert.equal(shouldPlaySignature({ key: "KEY", kind: "short" }, undefined), false);
});

test("action queue serializes: 2nd action starts only after 1st resolves", async () => {
  const q = createActionQueue();
  const log = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = q.run(async () => { log.push("a-start"); await gate; log.push("a-end"); });
  const b = q.run(async () => { log.push("b-start"); });
  await Promise.resolve();
  assert.deepEqual(log, ["a-start"]);                 // b 尚未开始 → tick 帧不会插进招牌
  release();
  await Promise.all([a, b]);
  assert.deepEqual(log, ["a-start", "a-end", "b-start"]);
});

test("a greeting press ALSO reaches the tick -- it is the working-day bond credit", async () => {
  const transport = createButtonTransport();
  const model = { buddy: { species: "eevee" } };
  const signatures = [];
  const lifecycle = [];
  const runs = [];
  const dispatcher = createButtonDispatcher({
    transport,
    getPet: () => ({ readyToEvolve: false }),
    getModel: () => model,
    actions: {
      run(fn) {
        const result = fn();
        runs.push(result);
        return result;
      },
    },
    animator: {
      pause: () => lifecycle.push("pause"),
      resume: () => lifecycle.push("resume"),
    },
    playSignature: async ({ model: pressModel }) => {
      signatures.push(pressModel);
    },
  });

  transport.emitButton({ key: "KEY", kind: "short" });
  await Promise.all(runs);

  assert.deepEqual(signatures, [model]);
  assert.deepEqual(lifecycle, ["pause", "resume"]);
  // Swallowing the event here (which this test used to assert) meant
  // applyBondTick never saw `clicked`, so the hourly half heart could not be
  // earned on a working day however many times the button was pressed.
  assert.deepEqual(dispatcher.drainTickEvents(), [{ key: "KEY", kind: "short" }]);
  dispatcher.stop();
  assert.equal(transport.listenerCount(), 0);
});

test("dispatcher drops rapid signature presses while one is in flight", async () => {
  const transport = createButtonTransport();
  const signatures = [];
  const runs = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const dispatcher = createButtonDispatcher({
    transport,
    getPet: () => ({ readyToEvolve: false }),
    getModel: () => ({ buddy: { species: "eevee" } }),
    actions: {
      run(fn) {
        const result = fn();
        runs.push(result);
        return result;
      },
    },
    playSignature: async () => {
      signatures.push("signature");
      await gate;
    },
  });

  transport.emitButton({ key: "KEY", kind: "short" });
  transport.emitButton({ key: "KEY", kind: "short" });
  transport.emitButton({ key: "KEY", kind: "short" });
  await Promise.resolve();

  assert.equal(signatures.length, 1);
  // Only the ANIMATION is deduped. Every press still reaches the tick: an
  // animation that happens to be mid-flight must not cost the owner their
  // bond credit for the hour.
  assert.equal(dispatcher.drainTickEvents().length, 3);
  release();
  await Promise.all(runs);
  dispatcher.stop();
});

test("pressing KEY during an open working-day slot earns the half heart", () => {
  const transport = createButtonTransport();
  const dispatcher = createButtonDispatcher({
    transport,
    getPet: () => ({ readyToEvolve: false }),   // i.e. the signature path
    getModel: () => ({ buddy: { species: "bulbasaur" } }),
    actions: { run: (fn) => Promise.resolve(fn()) },
    playSignature: async () => {},
  });

  transport.emitButton({ key: "KEY", kind: "short" });
  const pendingButtons = dispatcher.drainTickEvents();

  // Exactly what runOneTick derives `clicked` from.
  const clicked = pendingButtons.some((event) => event?.key === "KEY" && event?.kind === "short");
  assert.equal(clicked, true);

  const tuesday10am = new Date(2026, 6, 28, 10, 8);
  const before = { level: 9, exp: 3, bond: 8, bondDay: "2026-07-28", bondHalves: 0, bondSlots: 0 };
  const after = applyBondTick(before, { now: tuesday10am, today: "2026-07-28", clicked });

  assert.equal(after.bondHalves, 1);
  assert.equal(heartsFromHalves(after.bondHalves), 0.5);
  dispatcher.stop();
});

test("dispatcher queues ready KEY-short, long, and double presses for tick snapshots", () => {
  const transport = createButtonTransport();
  const dispatcher = createButtonDispatcher({
    transport,
    getPet: () => ({ readyToEvolve: true }),
  });

  transport.emitButton({ key: "KEY", kind: "short" });
  transport.emitButton({ key: "KEY", kind: "long" });
  transport.emitButton({ key: "KEY", kind: "double" });
  transport.emitButton({ key: "BOOT", kind: "short" });

  assert.deepEqual(dispatcher.drainTickEvents().map(({ kind }) => kind), ["short", "long", "double"]);
  dispatcher.stop();
});

test("dispatcher requeues a drained tick snapshot once without adding listeners", () => {
  const transport = createButtonTransport();
  const dispatcher = createButtonDispatcher({ transport });
  assert.equal(transport.listenerCount(), 1);

  transport.emitButton({ key: "KEY", kind: "long" });
  const firstDrain = dispatcher.drainTickEvents();
  assert.equal(firstDrain.length, 1);

  assert.equal(dispatcher.requeueForRetry(firstDrain), 1);
  assert.equal(transport.listenerCount(), 1);

  const retryDrain = dispatcher.drainTickEvents();
  assert.equal(retryDrain.length, 1);
  assert.equal(retryDrain[0].requeued, true);

  assert.equal(dispatcher.requeueForRetry(retryDrain), 0);
  assert.deepEqual(dispatcher.drainTickEvents(), []);
  dispatcher.stop();
  assert.equal(transport.listenerCount(), 0);
});

// The unit test above stops at applyBondTick. This one runs a press through
// runOneTick itself, which is where `clicked` is actually derived from the
// tick snapshot -- the link that had no coverage while the credit was being
// silently dropped.
test("runOneTick turns a queued KEY short press into the hour's bond credit", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cpb-bond-tick-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, "state.json");
  const saved = {
    schemaVersion: 1, hatched: true, species: "bulbasaur", level: 9, exp: 3, bond: 8,
    streak: 3, shield: 0, lastSettled: "2026-07-28", lastGrowthDay: "2026-07-28",
    bondDay: "2026-07-28", bondHalves: 0, bondSlots: 0,
    iv: [0, 1, 20, 5, 0, 13], nature: "慢性子", characteristic: "耐打", tutorialDone: true,
  };

  const runWith = async (pendingButtons) => {
    writeFileSync(statePath, JSON.stringify(saved));
    await runOneTick({
      usage: { ok: true, todayTokens: 0, todayPeriod: null, activeDays: [] },
      weather: { cond: "多云", temp: 14, humidity: 70 },
      room: { t: 20, h: 50 },
      statePath,
      framePath: join(dir, "frame.png"),
      transport: { push: async () => ({ ok: true }), setActiveCry: () => {}, playSound: () => {} },
      now: new Date(2026, 6, 28, 10, 30),   // Tuesday, inside the 9:00 window
      today: "2026-07-28",
      pendingButtons,
      buddyName: "Hughie",
    });
    return JSON.parse(readFileSync(statePath, "utf8"));
  };

  assert.equal((await runWith([])).bondHalves, 0);
  const pressed = await runWith([{ key: "KEY", kind: "short" }]);
  assert.equal(pressed.bondHalves, 1);
  assert.equal(pressed.bondSlots, 1 << 1);   // slot 1 = the 10:00 hour
});

function createButtonTransport() {
  const emitter = new EventEmitter();
  return {
    onButton(callback) {
      emitter.on("button", callback);
      return () => emitter.off("button", callback);
    },
    emitButton(event) {
      emitter.emit("button", event);
    },
    listenerCount() {
      return emitter.listenerCount("button");
    },
  };
}
