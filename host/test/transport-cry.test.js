import { test } from "node:test";
import assert from "node:assert/strict";

import { createTransport } from "../src/transport/index.js";

// 假串口：记录写出的帧 + 可触发 reconnect
function fakeSerialFactory() {
  const writes = [];
  let reconnectCb = null;
  const serial = {
    pushFrame: async () => ({ ok: true }),
    playSound() {},
    setActiveCry(id) { writes.push(["cry", id]); },
    sendVolume(volume) { writes.push(["volume", volume]); },
    onReconnect(cb) { reconnectCb = cb; return () => {}; },
    onButton() { return () => {}; },
    onSensor() { return () => {}; },
    feedSensor() { return null; },
    close() {},
    _fireReconnect: () => reconnectCb?.(),
    _writes: writes,
  };
  return async () => serial;
}

test("setActiveCry sends a CONFIG frame with the sound id", async () => {
  const fake = fakeSerialFactory();
  const t = await createTransport({ serialTransportFactory: fake });
  t.setActiveCry(7);
  // fake.setActiveCry 记录的是底层调用；断言其被调用且带 id
  const serial = await fake();
  assert.deepEqual(serial._writes.at(-1), ["cry", 7]);
});

test("setActiveCry is replayed after reconnect", async () => {
  const fake = fakeSerialFactory();
  const serial = await fake();
  const t = await createTransport({ serialTransportFactory: () => Promise.resolve(serial) });
  t.setActiveCry(9);
  serial._writes.length = 0;
  serial._fireReconnect();
  assert.deepEqual(serial._writes.at(-1), ["cry", 9]); // 重放
});

test("sendVolume sends a VOLUME downlink through the serial wrapper (RM12)", async () => {
  const fake = fakeSerialFactory();
  const t = await createTransport({ serialTransportFactory: fake });
  t.sendVolume(42);
  const serial = await fake();
  assert.deepEqual(serial._writes.at(-1), ["volume", 42]);
});

test("sendVolume is replayed after reconnect (RM12)", async () => {
  const fake = fakeSerialFactory();
  const serial = await fake();
  const t = await createTransport({ serialTransportFactory: () => Promise.resolve(serial) });
  t.sendVolume(55);
  serial._writes.length = 0;
  serial._fireReconnect();
  assert.deepEqual(serial._writes.at(-1), ["volume", 55]);
});

test("mock transport exposes a no-op setActiveCry", async () => {
  const t = await createTransport({ serialTransportFactory: async () => null });
  assert.equal(typeof t.setActiveCry, "function");
  assert.doesNotThrow(() => t.setActiveCry(5));
  t.close();
});

test("mock transport exposes a no-op sendVolume (RM12)", async () => {
  const t = await createTransport({ serialTransportFactory: async () => null });
  assert.equal(typeof t.sendVolume, "function");
  assert.doesNotThrow(() => t.sendVolume(5));
  t.close();
});
