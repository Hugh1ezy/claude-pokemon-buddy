import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createTransport } from "../src/transport/index.js";

const logger = { warn() {} };

test("serial takes priority over wifi when both are available", async () => {
  const serial = fakeInner();
  const wifi = fakeInner();
  let wifiCalls = 0;
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: async () => serial,
      wifiTransportFactory: async () => { wifiCalls += 1; return wifi; },
      mockFactory: () => fakeMock(),
      wifi: { enabled: true, token: "s3cr3t" },
      framePath: null,
      logger,
    });

    assert.equal(transport.getKind(), "serial");
    assert.equal(wifiCalls, 0); // wifi never even attempted once serial answered
  } finally {
    transport?.close();
  }
});

test("falls back to wifi when no serial device is found and wifi is enabled", async () => {
  const wifi = fakeInner();
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: async () => null,
      wifiTransportFactory: async () => wifi,
      mockFactory: () => fakeMock(),
      wifi: { enabled: true, token: "s3cr3t" },
      framePath: null,
      logger,
    });

    assert.equal(transport.getKind(), "wifi");
  } finally {
    transport?.close();
  }
});

test("does not attempt wifi discovery when wifi.enabled is not set", async () => {
  let wifiCalls = 0;
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: async () => null,
      wifiTransportFactory: async () => { wifiCalls += 1; return fakeInner(); },
      mockFactory: () => fakeMock(),
      framePath: null,
      logger,
    });

    assert.equal(transport.getKind(), "mock");
    assert.equal(wifiCalls, 0);
  } finally {
    transport?.close();
  }
});

test("falls back to mock when neither serial nor wifi is available", async () => {
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: async () => null,
      wifiTransportFactory: async () => null,
      mockFactory: () => fakeMock(),
      wifi: { enabled: true, token: "s3cr3t" },
      framePath: null,
      logger,
    });

    assert.equal(transport.getKind(), "mock");
  } finally {
    transport?.close();
  }
});

test("mock transport upgrades to wifi once a wifi device becomes reachable", async () => {
  const wifi = fakeInner();
  let calls = 0;
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: async () => null,
      wifiTransportFactory: async () => {
        calls += 1;
        return calls === 1 ? null : wifi; // first probe finds nothing, second succeeds
      },
      mockFactory: () => fakeMock(),
      wifi: { enabled: true, token: "s3cr3t" },
      reconnectDelayMs: 5,
      framePath: null,
      logger,
    });

    assert.equal(transport.getKind(), "mock");
    await waitFor(() => transport.getKind() === "wifi");
  } finally {
    transport?.close();
  }
});

test("a warm serial disconnect (not just a cold miss) falls back to mock and re-probes wifi", async () => {
  const serial = fakeInner();
  const wifi = fakeInner();
  let serialStillPlugged = true; // flips to simulate the cable actually being pulled, not just this instance dying
  let transport;
  try {
    transport = await createTransport({
      serialTransportFactory: async () => (serialStillPlugged ? serial : null),
      wifiTransportFactory: async () => wifi,
      mockFactory: () => fakeMock(),
      wifi: { enabled: true, token: "s3cr3t" },
      reconnectDelayMs: 5,
      framePath: null,
      logger,
    });

    assert.equal(transport.getKind(), "serial");

    serialStillPlugged = false;
    serial.emitDisconnect(); // e.g. USB unplugged mid-session

    // Must actually notice -- serial.js's own internal reconnect only knows
    // how to look for the same kind of transport again, so without wiring
    // onDisconnect through, the orchestrator would just keep reporting
    // "serial" forever with a dead transport underneath it.
    await waitFor(() => transport.getKind() === "mock");
    assert.equal(serial.closed, true); // old transport's internal retry loop must be stopped, not leaked

    await waitFor(() => transport.getKind() === "wifi");
  } finally {
    transport?.close();
  }
});

function fakeInner() {
  const events = new EventEmitter();
  const inner = {
    async pushFrame() { return { ok: true }; },
    playSound() {},
    setActiveCry() {},
    sendVolume() {},
    onButton(cb) { events.on("button", cb); return () => events.off("button", cb); },
    onSensor(cb) { events.on("sensor", cb); return () => events.off("sensor", cb); },
    onReconnect(cb) { events.on("reconnect", cb); return () => events.off("reconnect", cb); },
    onDisconnect(cb) { events.on("disconnect", cb); return () => events.off("disconnect", cb); },
    feedSensor() { return null; },
    getHello() { return null; },
    closed: false,
    close() { inner.closed = true; },
    emitDisconnect: () => events.emit("disconnect"),
  };
  return inner;
}

function fakeMock() {
  const events = new EventEmitter();
  return {
    async push() { return { ok: true }; },
    onButton(cb) { events.on("button", cb); return () => events.off("button", cb); },
    injectButton(key, kind = "short") { events.emit("button", { key, kind }); },
    feedSensor() { return null; },
    sendVolume() {},
  };
}

async function waitFor(predicate, { timeoutMs = 500, intervalMs = 5 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
