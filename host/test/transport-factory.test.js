import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { runOneTick } from "../src/index.js";
import { rleDecode } from "../src/transport/proto.js";
import { createTransport } from "../src/transport/index.js";

test("createTransport logs mock fallback once", async () => {
  const warnings = [];
  const logger = { warn: (message) => warnings.push(String(message)) };
  let first;
  let second;
  try {
    first = await createTransport({
      serialTransportFactory: async () => null,
      logger,
    });
    second = await createTransport({
      serialTransportFactory: async () => null,
      logger,
    });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /mock transport/);
  } finally {
    first?.close();
    second?.close();
  }
});

test("createTransport falls back to mock when no ESP serial port is found", async () => {
  const framePath = join("out", "test-factory-mock.png");
  rmSync(framePath, { force: true });
  let transport;
  try {
    transport = await createTransport({
      framePath,
      serialTransportFactory: async () => null,
    });
    await transport.push(Buffer.from([1, 2, 3]));

    assert.equal(existsSync(framePath), true);
    assert.deepEqual([...readFileSync(framePath)], [1, 2, 3]);
  } finally {
    transport?.close();
  }
});

test("createTransport sends dirty-rect payloads through detected serial transport", async () => {
  const sent = [];
  const transport = await createTransport({
    serialTransportFactory: async () => ({
      pushFrame(payload) {
        sent.push(payload);
        return Promise.resolve({ ok: true });
      },
      onButton() {
        return () => {};
      },
      feedSensor() {
        return { t: 22.5, h: 51 };
      },
    }),
  });

  await transport.push({
    pngBuffer: Buffer.from([9]),
    bitmap: { w: 16, h: 1, bytes: Uint8Array.from([0, 0x40]) },
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(readDirtyHeader(sent[0]), { x: 0, y: 0, w: 16, h: 1 });
  assert.deepEqual([...rleDecode(sent[0].slice(8))], [0, 0x40]);
});

// The host used to discard push results entirely, so its log said `wrote
// out/frame.png` at the same rate whether or not a single pixel reached the
// device -- a whole night of it on 2026-08-01, and minutes of it on 2026-08-04
// that could only be diagnosed by stopping the host and probing by hand.
test("a frame the device does not take is reported, once per edge", async () => {
  const logs = [];
  const warns = [];
  const logger = { log: (m) => logs.push(String(m)), warn: (m) => warns.push(String(m)) };
  let taken = false;
  const transport = await createTransport({
    logger,
    serialTransportFactory: async () => ({
      pushFrame: () => Promise.resolve(taken ? { ok: true } : { ok: false, stale: true, seq: 0 }),
      onButton: () => () => {},
      feedSensor: () => null,
    }),
  });

  try {
    const frame = (byte) => ({ pngBuffer: null, bitmap: { w: 16, h: 1, bytes: Uint8Array.from([0, byte]) } });

    await transport.push(frame(0x40));
    assert.equal(warns.length, 1, "the first drop has to say so");
    assert.match(warns[0], /did not take the frame \(no ACK after retries\)/);
    assert.match(warns[0], /showing whatever it last received/);

    await transport.push(frame(0x20));
    await transport.push(frame(0x10));
    assert.equal(warns.length, 1, "and then stay quiet -- the animator pushes 3x a second");

    taken = true;
    await transport.push(frame(0x08));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /taking frames again \(3 dropped\)/);

    // Back to healthy: a later drop is a new edge and reports again.
    taken = false;
    await transport.push(frame(0x04));
    assert.equal(warns.length, 2);
  } finally {
    transport?.close();
  }
});

test("an unchanged frame is not counted as the device taking one", async () => {
  const logs = [];
  const warns = [];
  const transport = await createTransport({
    logger: { log: (m) => logs.push(String(m)), warn: (m) => warns.push(String(m)) },
    serialTransportFactory: async () => ({
      pushFrame: () => Promise.resolve({ ok: false, stale: true }),
      onButton: () => () => {},
      feedSensor: () => null,
    }),
  });

  try {
    const same = () => ({ pngBuffer: null, bitmap: { w: 16, h: 1, bytes: Uint8Array.from([0, 0x40]) } });
    await transport.push(same());       // drops -> previousBytes stays null
    const result = await transport.push(same());
    // previousBytes is still null (the first push failed), so this is a real
    // send too. The property under test is the one below it.
    assert.equal(result.ok, false);
    assert.equal(logs.length, 0, "a drop must never be reported as a recovery");
  } finally {
    transport?.close();
  }
});

test("runOneTick pushes the rendered bitmap through the selected transport", async () => {
  const statePath = join("out", "test-factory-loop-state.json");
  const framePath = join("out", "test-factory-loop-frame.png");
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.bak`, { force: true });
  rmSync(framePath, { force: true });
  const pushed = [];

  await runOneTick({
    usage: usageWithTokens(1_000),
    weather: sampleWeather(),
    statePath,
    framePath,
    today: "2026-05-30",
    transportFactory: async () => ({
      push(frame) {
        pushed.push(frame);
        return Promise.resolve({ ok: true });
      },
      onButton() {
        return () => {};
      },
      feedSensor() {
        return { t: 23.4, h: 56 };
      },
    }),
  });

  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].bitmap.w, 400);
  assert.equal(pushed[0].bitmap.h, 300);
  assert.ok(pushed[0].bitmap.bytes.length > 0);
  assert.ok(pushed[0].pngBuffer.length > 0);
});

function readDirtyHeader(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    x: view.getUint16(0, true),
    y: view.getUint16(2, true),
    w: view.getUint16(4, true),
    h: view.getUint16(6, true),
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
