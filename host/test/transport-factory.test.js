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

  const first = await createTransport({
    serialTransportFactory: async () => null,
    logger,
  });
  const second = await createTransport({
    serialTransportFactory: async () => null,
    logger,
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /mock transport/);
  first.close();
  second.close();
});

test("createTransport falls back to mock when no ESP serial port is found", async () => {
  const framePath = join("out", "test-factory-mock.png");
  rmSync(framePath, { force: true });

  const transport = await createTransport({
    framePath,
    serialTransportFactory: async () => null,
  });
  await transport.push(Buffer.from([1, 2, 3]));

  assert.equal(existsSync(framePath), true);
  assert.deepEqual([...readFileSync(framePath)], [1, 2, 3]);
  transport.close();
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
