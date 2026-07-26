import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createTransport } from "../src/transport/index.js";
import { rleDecode } from "../src/transport/proto.js";

const logger = { warn() {} };

test("T1: mock transport upgrades in place and subsequent push uses serial", async () => {
  const serial = makeSerial();
  const probe = makeUpgradeFactory(serial.transport);
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: probe.factory,
      mockFactory: () => makeMock().transport,
      reconnectDelayMs: 5,
      framePath: null,
      logger,
    });

    assert.equal(transport.getKind(), "mock");
    await waitFor(() => transport.getKind() === "serial");
    await transport.push(frame([0x80]));

    assert.equal(serial.frames.length, 1);
  } finally {
    transport?.close();
  }
});

test("T2: upgrade redraws the cached frame as a full-screen dirty rect", async () => {
  const serial = makeSerial();
  const probe = makeUpgradeFactory(serial.transport);
  const a = frame([0x80, 0x01]);
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: probe.factory,
      mockFactory: () => makeMock().transport,
      reconnectDelayMs: 5,
      framePath: null,
      logger,
    });

    await transport.push(a);
    await waitFor(() => serial.frames.length === 1);

    const dirty = readDirty(serial.frames[0]);
    assert.deepEqual(dirty.header, { x: 0, y: 0, w: 16, h: 1 });
    assert.deepEqual([...dirty.bytes], [...a.bitmap.bytes]);
  } finally {
    transport?.close();
  }
});

test("T2b: redraw establishes the diff baseline for the next frame", async () => {
  const serial = makeSerial();
  const probe = makeUpgradeFactory(serial.transport);
  const a = frame([0x80, 0x00]);
  const b = frame([0x80, 0x01]);
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: probe.factory,
      mockFactory: () => makeMock().transport,
      reconnectDelayMs: 5,
      framePath: null,
      logger,
    });

    await transport.push(a);
    await waitFor(() => serial.frames.length === 1);
    await transport.push(b);

    const dirty = readDirty(serial.frames[1]);
    assert.deepEqual(dirty.header, { x: 8, y: 0, w: 8, h: 1 });
    assert.deepEqual([...dirty.bytes], [0x01]);
  } finally {
    transport?.close();
  }
});

test("T3: upgrade replays the last active cry", async () => {
  const serial = makeSerial();
  const probe = makeUpgradeFactory(serial.transport);
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: probe.factory,
      mockFactory: () => makeMock().transport,
      reconnectDelayMs: 5,
      logger,
    });

    transport.setActiveCry(9);
    await waitFor(() => transport.getKind() === "serial");

    assert.deepEqual(serial.writes, [["cry", 9]]);
  } finally {
    transport?.close();
  }
});

test("T4: upgrade replays the last volume", async () => {
  const serial = makeSerial();
  const probe = makeUpgradeFactory(serial.transport);
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: probe.factory,
      mockFactory: () => makeMock().transport,
      reconnectDelayMs: 5,
      logger,
    });

    transport.sendVolume(55);
    await waitFor(() => transport.getKind() === "serial");

    assert.deepEqual(serial.writes, [["volume", 55]]);
  } finally {
    transport?.close();
  }
});

test("T5: in-flight mock push and queued push cross upgrade without double delivery", async () => {
  let releaseProbe;
  let signalProbe;
  let releaseMock;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  const probeStarted = new Promise((resolve) => { signalProbe = resolve; });
  const mockGate = new Promise((resolve) => { releaseMock = resolve; });
  const serial = makeSerial();
  const mock = makeMock({
    push: async () => {
      await mockGate;
      return { ok: true };
    },
  });
  let calls = 0;
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: async () => {
        calls += 1;
        if (calls === 1) return null;
        signalProbe();
        await probeGate;
        return serial.transport;
      },
      mockFactory: () => mock.transport,
      reconnectDelayMs: 5,
      framePath: null,
      logger,
    });

    await probeStarted;
    const a = frame([0x80], 0xa1);
    const b = frame([0x01], 0xb2);
    const pushA = transport.push(a);
    await waitFor(() => mock.pushes.length === 1);
    const pushB = transport.push(b);

    releaseProbe();
    await waitFor(() => transport.getKind() === "serial");
    releaseMock();
    await Promise.all([pushA, pushB]);

    assert.deepEqual(mock.pushes.map((png) => png[0]), [0xa1]);
    assert.equal(serial.frames.length, 1);
    assert.deepEqual([...readDirty(serial.frames[0]).bytes], [...b.bitmap.bytes]);
  } finally {
    releaseProbe?.();
    releaseMock?.();
    transport?.close();
  }
});

test("T6: successful upgrade stops probing and attaches only one serial", async () => {
  const serial = makeSerial();
  const probe = makeUpgradeFactory(serial.transport);
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: probe.factory,
      mockFactory: () => makeMock().transport,
      reconnectDelayMs: 5,
      logger,
    });

    await waitFor(() => transport.getKind() === "serial");
    const callsAfterUpgrade = probe.calls();
    await sleep(20);

    assert.equal(probe.calls(), callsAfterUpgrade);
    assert.equal(serial.listenerCount("button"), 1);
  } finally {
    transport?.close();
  }
});

test("T7: thrown and null probe failures recover on a later successful probe", async () => {
  const serial = makeSerial();
  let calls = 0;
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: async () => {
        calls += 1;
        if (calls === 1) return null;
        if (calls === 2) throw new Error("probe failed");
        if (calls === 3) return null;
        return serial.transport;
      },
      mockFactory: () => makeMock().transport,
      reconnectDelayMs: 5,
      logger,
    });

    await waitFor(() => transport.getKind() === "serial");

    assert.equal(calls, 4);
  } finally {
    transport?.close();
  }
});

test("T8: close stops future probes", async () => {
  let calls = 0;
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: async () => {
        calls += 1;
        return null;
      },
      mockFactory: () => makeMock().transport,
      reconnectDelayMs: 5,
      logger,
    });

    await waitFor(() => calls >= 2);
    const timeoutsBeforeClose = process.getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;
    transport.close();
    const timeoutsAfterClose = process.getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;
    const callsAfterClose = calls;
    await sleep(20);

    assert.ok(timeoutsAfterClose < timeoutsBeforeClose);
    assert.equal(calls, callsAfterClose);
  } finally {
    transport?.close();
  }
});

test("T9: close during a probe closes the freshly opened serial without attaching", async () => {
  let releaseProbe;
  let signalProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  const probeStarted = new Promise((resolve) => { signalProbe = resolve; });
  const serial = makeSerial();
  let calls = 0;
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: async () => {
        calls += 1;
        if (calls === 1) return null;
        signalProbe();
        await probeGate;
        return serial.transport;
      },
      mockFactory: () => makeMock().transport,
      reconnectDelayMs: 5,
      logger,
    });

    await probeStarted;
    transport.close();
    releaseProbe();
    await waitFor(() => serial.closed() === 1);

    assert.equal(transport.getKind(), "mock");
    assert.equal(serial.listenerCount("button"), 0);
  } finally {
    releaseProbe?.();
    transport?.close();
  }
});

test("T9b: close after upgrade closes the attached serial exactly once", async () => {
  const serial = makeSerial();
  const probe = makeUpgradeFactory(serial.transport);
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: probe.factory,
      mockFactory: () => makeMock().transport,
      reconnectDelayMs: 5,
      logger,
    });

    await waitFor(() => transport.getKind() === "serial");
    transport.close();
    transport = null;

    assert.equal(serial.closed(), 1);
  } finally {
    transport?.close();
  }
});

test("T10: button subscription registered in mock mode survives upgrade", async () => {
  const serial = makeSerial();
  const probe = makeUpgradeFactory(serial.transport);
  const buttons = [];
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: probe.factory,
      mockFactory: () => makeMock().transport,
      reconnectDelayMs: 5,
      logger,
    });
    transport.onButton((event) => buttons.push(event));

    await waitFor(() => transport.getKind() === "serial");
    serial.emitButton({ key: "KEY", kind: "short" });

    assert.deepEqual(buttons, [{ key: "KEY", kind: "short" }]);
  } finally {
    transport?.close();
  }
});

test("T10b: sensor and reconnect subscriptions survive upgrade", async () => {
  const serial = makeSerial();
  const probe = makeUpgradeFactory(serial.transport);
  const sensors = [];
  let reconnects = 0;
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: probe.factory,
      mockFactory: () => makeMock().transport,
      reconnectDelayMs: 5,
      logger,
    });
    transport.onSensor((event) => sensors.push(event));
    transport.onReconnect(() => { reconnects += 1; });

    await waitFor(() => reconnects === 1);
    serial.emitSensor({ t: 18.7, h: 44 });
    serial.emitReconnect();

    assert.deepEqual(sensors, [{ t: 18.7, h: 44 }]);
    assert.equal(reconnects, 2);
  } finally {
    transport?.close();
  }
});

test("T10c: off returned before upgrade still removes the facade subscription", async () => {
  const serial = makeSerial();
  const probe = makeUpgradeFactory(serial.transport);
  let calls = 0;
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: probe.factory,
      mockFactory: () => makeMock().transport,
      reconnectDelayMs: 5,
      logger,
    });
    const off = transport.onButton(() => { calls += 1; });

    await waitFor(() => transport.getKind() === "serial");
    serial.emitButton({ key: "KEY", kind: "short" });
    off();
    serial.emitButton({ key: "KEY", kind: "short" });

    assert.equal(calls, 1);
  } finally {
    transport?.close();
  }
});

test("T10d: reconnect resets the diff baseline before an identical frame", async () => {
  const serial = makeSerial();
  const probe = makeUpgradeFactory(serial.transport);
  const a = frame([0x80, 0x01]);
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: probe.factory,
      mockFactory: () => makeMock().transport,
      reconnectDelayMs: 5,
      framePath: null,
      logger,
    });

    await waitFor(() => transport.getKind() === "serial");
    await transport.push(a);
    assert.deepEqual(await transport.push(a), { ok: true, skipped: true });

    serial.emitReconnect();
    await transport.push(a);

    assert.equal(serial.frames.length, 2);
    const dirty = readDirty(serial.frames.at(-1));
    assert.deepEqual(dirty.header, { x: 0, y: 0, w: 16, h: 1 });
    assert.deepEqual([...dirty.bytes], [...a.bitmap.bytes]);
  } finally {
    transport?.close();
  }
});

test("T11: feedSensor switches from mock data to the serial transport", async () => {
  const serial = makeSerial({ sensor: { t: 18.2, h: 47 } });
  const probe = makeUpgradeFactory(serial.transport);
  const mock = makeMock({ sensor: { t: 23.4, h: 56 } });
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: probe.factory,
      mockFactory: () => mock.transport,
      reconnectDelayMs: 5,
      logger,
    });

    assert.deepEqual(transport.feedSensor(), { t: 23.4, h: 56 });
    await waitFor(() => transport.getKind() === "serial");

    assert.deepEqual(transport.feedSensor(), { t: 18.2, h: 47 });
  } finally {
    transport?.close();
  }
});

test("T12: mock push, sensors, cry, and volume behavior remains compatible", async () => {
  const framePath = join("out", "test-transport-upgrade-mock.png");
  rmSync(framePath, { force: true });
  let transport;
  try {
    transport = await createTransport({
      framePath,
      serialTransportFactory: async () => null,
      reconnectDelayMs: 5,
      logger,
    });

    await transport.push(Buffer.from([1, 2, 3]));

    assert.equal(existsSync(framePath), true);
    assert.deepEqual([...readFileSync(framePath)], [1, 2, 3]);
    assert.deepEqual(transport.feedSensor(), { t: 23.4, h: 56 });
    assert.doesNotThrow(() => transport.setActiveCry(9));
    assert.doesNotThrow(() => transport.sendVolume(55));
  } finally {
    transport?.close();
    rmSync(framePath, { force: true });
  }
});

test("T13: spread facade keeps upgrade state, subscriptions, replay, and passthroughs", async () => {
  const sensor = { t: 18.2, h: 47 };
  const serial = makeSerial({ sensor });
  const probe = makeUpgradeFactory(serial.transport);
  const a = frame([0x80, 0x01]);
  const buttons = [];
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: probe.factory,
      mockFactory: () => makeMock().transport,
      reconnectDelayMs: 5,
      framePath: null,
      logger,
    });
    const spread = { ...transport };
    spread.onButton((event) => buttons.push(event));
    spread.setActiveCry(9);
    spread.sendVolume(55);
    await spread.push(a);

    await waitFor(() => transport.getKind() === "serial");
    await waitFor(() => serial.frames.length === 1);

    const dirty = readDirty(serial.frames[0]);
    assert.deepEqual(dirty.header, { x: 0, y: 0, w: 16, h: 1 });
    assert.deepEqual([...dirty.bytes], [...a.bitmap.bytes]);
    serial.emitButton({ key: "KEY", kind: "short" });
    assert.deepEqual(buttons, [{ key: "KEY", kind: "short" }]);
    assert.deepEqual(serial.writes, [["cry", 9], ["volume", 55]]);
    spread.playSound(3);
    assert.deepEqual(serial.sounds, [3]);
    assert.deepEqual(spread.feedSensor(), sensor);
  } finally {
    transport?.close();
  }
});

function makeUpgradeFactory(serial) {
  let calls = 0;
  return {
    async factory() {
      calls += 1;
      return calls === 1 ? null : serial;
    },
    calls: () => calls,
  };
}

function makeSerial({ sensor = null } = {}) {
  const events = new EventEmitter();
  const frames = [];
  const writes = [];
  const sounds = [];
  let closeCount = 0;
  const transport = {
    async pushFrame(payload) {
      frames.push(Uint8Array.from(payload));
      return { ok: true };
    },
    playSound(id) {
      sounds.push(id);
    },
    setActiveCry(id) {
      writes.push(["cry", id]);
    },
    sendVolume(volume) {
      writes.push(["volume", volume]);
    },
    onButton(callback) {
      events.on("button", callback);
      return () => events.off("button", callback);
    },
    onSensor(callback) {
      events.on("sensor", callback);
      return () => events.off("sensor", callback);
    },
    onReconnect(callback) {
      events.on("reconnect", callback);
      return () => events.off("reconnect", callback);
    },
    feedSensor() {
      return sensor ? { ...sensor } : null;
    },
    getHello() {
      return null;
    },
    close() {
      closeCount += 1;
    },
  };
  return {
    transport,
    frames,
    writes,
    sounds,
    emitButton: (event) => events.emit("button", event),
    emitSensor: (event) => events.emit("sensor", event),
    emitReconnect: () => events.emit("reconnect"),
    listenerCount: (name) => events.listenerCount(name),
    closed: () => closeCount,
  };
}

function makeMock({ push, sensor = { t: 23.4, h: 56 } } = {}) {
  const events = new EventEmitter();
  const pushes = [];
  const transport = {
    async push(pngBuffer) {
      pushes.push(pngBuffer);
      return push ? push(pngBuffer) : { ok: true };
    },
    onButton(callback) {
      events.on("button", callback);
      return () => events.off("button", callback);
    },
    injectButton(key, kind = "short") {
      events.emit("button", { key, kind });
    },
    feedSensor() {
      return { ...sensor };
    },
    sendVolume() {},
  };
  return { transport, pushes };
}

function frame(bytes, pngByte = 0x89) {
  return {
    pngBuffer: Buffer.from([pngByte]),
    bitmap: {
      bytes: Uint8Array.from(bytes),
      w: bytes.length * 8,
      h: 1,
    },
  };
}

function readDirty(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    header: {
      x: view.getUint16(0, true),
      y: view.getUint16(2, true),
      w: view.getUint16(4, true),
      h: view.getUint16(6, true),
    },
    bytes: rleDecode(payload.slice(8)),
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await sleep(2);
  }
  assert.equal(predicate(), true);
}
