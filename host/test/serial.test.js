import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeFrame, encodeFrame, MAGIC, T } from "../src/transport/proto.js";
import { createSerialTransport, findEspPort, makeTransport } from "../src/transport/serial.js";

test("findEspPort returns first serial path with Espressif VID 303A", async () => {
  const SerialPort = {
    async list() {
      return [
        { path: "/dev/cu.other", vendorId: "10C4" },
        { path: "/dev/cu.usbmodem101", vendorId: "303a" },
      ];
    },
  };

  assert.equal(await findEspPort({ SerialPort }), "/dev/cu.usbmodem101");
});

test("pushFrame writes FRAME and resolves only after matching ACK", async () => {
  const port = new FakePort();
  const transport = makeTransport({ port, timeoutMs: 50, maxRetries: 0 });

  const sent = transport.pushFrame(Uint8Array.from([1, 2, 3]));
  assert.equal(port.writes.length, 1);
  const frame = decodeFrame(port.writes[0]);
  assert.equal(frame.type, T.FRAME);
  assert.equal(frame.seq, 0);
  assert.deepEqual([...frame.payload], [1, 2, 3]);

  let settled = false;
  sent.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  port.emitData(encodeFrame({ type: T.ACK, seq: frame.seq, payload: Uint8Array.from([frame.seq]) }));
  assert.deepEqual(await sent, { ok: true, seq: 0 });
});

test("pushFrame keeps later frames queued until the current frame is ACKed", async () => {
  const port = new FakePort();
  const transport = makeTransport({ port, timeoutMs: 50, maxRetries: 0 });

  const first = transport.pushFrame(Uint8Array.from([1]));
  const second = transport.pushFrame(Uint8Array.from([2]));
  assert.equal(port.writes.length, 1);

  const firstFrame = decodeFrame(port.writes[0]);
  port.emitData(encodeFrame({ type: T.ACK, seq: firstFrame.seq, payload: Uint8Array.from([firstFrame.seq]) }));
  assert.deepEqual(await first, { ok: true, seq: 0 });

  assert.equal(port.writes.length, 2);
  const secondFrame = decodeFrame(port.writes[1]);
  assert.equal(secondFrame.seq, 1);
  assert.deepEqual([...secondFrame.payload], [2]);

  port.emitData(encodeFrame({ type: T.ACK, seq: secondFrame.seq, payload: Uint8Array.from([secondFrame.seq]) }));
  assert.deepEqual(await second, { ok: true, seq: 1 });
});

test("incoming BUTTON and SENSOR frames dispatch callbacks", () => {
  const port = new FakePort();
  const transport = makeTransport({ port });
  const buttons = [];
  const sensors = [];

  transport.onButton((event) => buttons.push(event));
  transport.onSensor((event) => sensors.push(event));
  port.emitData(encodeFrame({ type: T.BUTTON, seq: 9, payload: Uint8Array.from([1, 2]) }));
  port.emitData(encodeFrame({ type: T.SENSOR, seq: 10, payload: sensorPayload(234, 56) }));

  assert.deepEqual(buttons, [{ key: "KEY", kind: "long" }]);
  assert.deepEqual(sensors, [{ t: 23.4, h: 56, battery: null }]);
  assert.deepEqual(transport.feedSensor(), { t: 23.4, h: 56, battery: null });
});

test("SENSOR frames carry battery percent when present, null when the 0xff unknown sentinel is sent", () => {
  const port = new FakePort();
  const transport = makeTransport({ port });

  port.emitData(encodeFrame({ type: T.SENSOR, seq: 1, payload: sensorPayload(220, 40, 87) }));
  assert.deepEqual(transport.feedSensor(), { t: 22.0, h: 40, battery: 87 });

  port.emitData(encodeFrame({ type: T.SENSOR, seq: 2, payload: sensorPayload(220, 40, 0xff) }));
  assert.deepEqual(transport.feedSensor(), { t: 22.0, h: 40, battery: null });
  transport.close();
});

test("malformed BUTTON payloads are ignored instead of emitting null events (RL7)", () => {
  const port = new FakePort();
  const transport = makeTransport({ port });
  const buttons = [];

  transport.onButton((event) => buttons.push(event));
  port.emitData(encodeFrame({ type: T.BUTTON, seq: 9, payload: Uint8Array.from([]) }));
  port.emitData(encodeFrame({ type: T.BUTTON, seq: 10, payload: Uint8Array.from([1]) }));

  assert.deepEqual(buttons, []);
  transport.close();
});

test("incoming HELLO stores firmware protocol info and stays queryable (RM8)", () => {
  const port = new FakePort();
  const warnings = [];
  const transport = makeTransport({
    port,
    logger: { warn: (message) => warnings.push(String(message)) },
  });

  port.emitData(encodeFrame({ type: T.HELLO, seq: 0, payload: Uint8Array.from([1, 21]) }));

  assert.deepEqual(transport.getHello(), { protoVer: 1, sndCount: 21 });
  assert.deepEqual(warnings, []);
  transport.close();
});

test("HELLO protocol mismatches are warned once per mismatch kind (RM8)", () => {
  const port = new FakePort();
  const warnings = [];
  const transport = makeTransport({
    port,
    logger: { warn: (message) => warnings.push(String(message)) },
  });

  port.emitData(encodeFrame({ type: T.HELLO, seq: 0, payload: Uint8Array.from([2, 20]) }));
  port.emitData(encodeFrame({ type: T.HELLO, seq: 0, payload: Uint8Array.from([2, 20]) }));

  assert.deepEqual(transport.getHello(), { protoVer: 2, sndCount: 20 });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /protocol/i);
  assert.match(warnings[1], /sound/i);
  transport.close();
});

test("pushFrame resends on timeout and resolves stale after max retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const port = new FakePort();
  const transport = makeTransport({ port, maxRetries: 2 });

  const result = transport.pushFrame(Uint8Array.from([9]));
  t.mock.timers.tick(250);
  t.mock.timers.tick(250);
  t.mock.timers.tick(250);

  assert.equal(port.writes.length, 3);
  assert.deepEqual(await result, { ok: false, stale: true, seq: 0 });
});

test("NACK retries count toward maxRetries and eventually resolve stale (RL9)", async () => {
  const port = new FakePort();
  const transport = makeTransport({ port, maxRetries: 2 });

  const result = transport.pushFrame(Uint8Array.from([9]));
  assert.equal(port.writes.length, 1);
  let frame = decodeFrame(port.writes.at(-1));

  port.emitData(encodeFrame({ type: T.NACK, seq: frame.seq, payload: Uint8Array.from([frame.seq]) }));
  assert.equal(port.writes.length, 2);
  frame = decodeFrame(port.writes.at(-1));

  port.emitData(encodeFrame({ type: T.NACK, seq: frame.seq, payload: Uint8Array.from([frame.seq]) }));
  assert.equal(port.writes.length, 3);
  frame = decodeFrame(port.writes.at(-1));

  port.emitData(encodeFrame({ type: T.NACK, seq: frame.seq, payload: Uint8Array.from([frame.seq]) }));
  assert.deepEqual(await withTimeout(result, 20), { ok: false, stale: true, seq: 0 });
});

test("close resolves an in-flight pushFrame as disconnected (RH2)", async () => {
  const port = new FakePort();
  const transport = makeTransport({ port, maxRetries: 0 });

  const result = transport.pushFrame(Uint8Array.from([9]));
  assert.equal(port.writes.length, 1);

  transport.close();

  assert.deepEqual(await withTimeout(result, 20), { ok: false, disconnected: true });
});

test("pushFrame resolves disconnected immediately after port close", async () => {
  const port = new FakePort();
  const transport = makeTransport({
    port,
    openPort: async () => null,
    reconnectDelayMs: 5,
  });

  port.emitClose();

  const result = await transport.pushFrame(Uint8Array.from([1]));

  assert.deepEqual(result, { ok: false, disconnected: true });
  assert.equal(port.writes.length, 0);
  transport.close();
});

test("pushFrame uses a reconnected port after close", async () => {
  const port1 = new FakePort();
  const port2 = new FakePort();
  const transport = makeTransport({
    port: port1,
    openPort: async () => port2,
    reconnectDelayMs: 5,
    timeoutMs: 50,
    maxRetries: 0,
  });

  port1.emitClose();
  await waitFor(() => port2.listenerCount("data") > 0);

  const sent = transport.pushFrame(Uint8Array.from([7]));
  assert.equal(port2.writes.length, 1);
  const frame = decodeFrame(port2.writes[0]);

  port2.emitData(encodeFrame({ type: T.ACK, seq: frame.seq, payload: Uint8Array.from([frame.seq]) }));

  assert.deepEqual(await sent, { ok: true, seq: 0 });
  transport.close();
});

test("onReconnect callback runs after automatic reconnect", async () => {
  const port1 = new FakePort();
  const port2 = new FakePort();
  const transport = makeTransport({
    port: port1,
    openPort: async () => port2,
    reconnectDelayMs: 5,
  });
  let reconnects = 0;

  const off = transport.onReconnect(() => {
    reconnects += 1;
  });
  port1.emitClose();

  await waitFor(() => reconnects === 1);
  assert.equal(reconnects, 1);
  off();
  transport.close();
});

test("automatic reconnect retries until openPort returns a port", async () => {
  const port1 = new FakePort();
  const port2 = new FakePort();
  let attempts = 0;
  const transport = makeTransport({
    port: port1,
    openPort: async () => {
      attempts += 1;
      return attempts < 3 ? null : port2;
    },
    reconnectDelayMs: 5,
    timeoutMs: 50,
    maxRetries: 0,
  });

  port1.emitClose();
  await waitFor(() => attempts >= 3 && port2.listenerCount("data") > 0);

  const sent = transport.pushFrame(Uint8Array.from([8]));
  const frame = decodeFrame(port2.writes[0]);
  port2.emitData(encodeFrame({ type: T.ACK, seq: frame.seq, payload: Uint8Array.from([frame.seq]) }));

  assert.deepEqual(await sent, { ok: true, seq: 0 });
  transport.close();
});

test("button and sensor callbacks remain active after reconnect", async () => {
  const port1 = new FakePort();
  const port2 = new FakePort();
  const transport = makeTransport({
    port: port1,
    openPort: async () => port2,
    reconnectDelayMs: 5,
  });
  const buttons = [];
  const sensors = [];

  transport.onButton((event) => buttons.push(event));
  transport.onSensor((event) => sensors.push(event));
  port1.emitClose();
  await waitFor(() => port2.listenerCount("data") > 0);

  port2.emitData(encodeFrame({ type: T.BUTTON, seq: 9, payload: Uint8Array.from([2, 5]) }));
  port2.emitData(encodeFrame({ type: T.SENSOR, seq: 10, payload: sensorPayload(187, 44) }));

  assert.deepEqual(buttons, [{ key: "BOOT", kind: "up" }]);
  assert.deepEqual(sensors, [{ t: 18.7, h: 44, battery: null }]);
  assert.deepEqual(transport.feedSensor(), { t: 18.7, h: 44, battery: null });
  transport.close();
});

test("disconnect clears stale sensor state and the reconnected port ACKs normally (RM6)", async () => {
  const port1 = new FakePort();
  const port2 = new FakePort();
  const transport = makeTransport({
    port: port1,
    openPort: async () => port2,
    reconnectDelayMs: 5,
  });

  port1.emitData(encodeFrame({ type: T.SENSOR, seq: 1, payload: sensorPayload(211, 51) }));
  assert.deepEqual(transport.feedSensor(), { t: 21.1, h: 51, battery: null });

  port1.emitClose();
  await waitFor(() => port2.listenerCount("data") > 0);
  assert.equal(transport.feedSensor(), null);

  const sent = transport.pushFrame(Uint8Array.from([4]));
  const frame = decodeFrame(port2.writes[0]);
  port2.emitData(encodeFrame({ type: T.ACK, seq: frame.seq, payload: Uint8Array.from([frame.seq]) }));
  assert.deepEqual(await sent, { ok: true, seq: 0 });
  transport.close();
});

test("close during reconnect closes the freshly opened port instead of reviving transport (RM6)", async () => {
  let releaseOpen;
  const opening = new Promise((resolve) => { releaseOpen = resolve; });
  const port1 = new FakePort();
  const port2 = new FakePort();
  const transport = makeTransport({
    port: port1,
    openPort: async () => {
      await opening;
      return port2;
    },
    reconnectDelayMs: 5,
  });
  let reconnects = 0;
  transport.onReconnect(() => { reconnects += 1; });

  port1.emitClose();
  await sleep(10);
  transport.close();
  releaseOpen();
  await sleep(10);

  assert.equal(port2.closed, true);
  assert.equal(port2.listenerCount("data"), 0);
  assert.equal(reconnects, 0);
});

test("large payload retry timeout scales beyond the fixed 250ms window (RM9-host)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const port = new FakePort();
  const transport = makeTransport({ port, maxRetries: 1 });

  transport.pushFrame(new Uint8Array(30 * 1024));

  assert.equal(port.writes.length, 1);
  t.mock.timers.tick(2069);
  assert.equal(port.writes.length, 1);
  t.mock.timers.tick(1);
  assert.equal(port.writes.length, 2);
  transport.close();
});

test("close stops reconnect attempts", async () => {
  const port = new FakePort();
  let attempts = 0;
  const transport = makeTransport({
    port,
    openPort: async () => {
      attempts += 1;
      return null;
    },
    reconnectDelayMs: 5,
  });

  transport.close();
  port.emitClose();
  await sleep(20);

  assert.equal(attempts, 0);
});

test("write callback errors trigger reconnect instead of rejecting", async () => {
  const port1 = new FakePort();
  const port2 = new FakePort();
  let attempts = 0;
  port1.writeError = new Error("disconnected");
  const transport = makeTransport({
    port: port1,
    openPort: async () => {
      attempts += 1;
      return port2;
    },
    reconnectDelayMs: 5,
    timeoutMs: 50,
  });

  const result = await transport.pushFrame(Uint8Array.from([1]));

  assert.deepEqual(result, { ok: false, disconnected: true });
  await waitFor(() => attempts === 1);
  transport.close();
});

test("setActiveCry writes a CONFIG frame with the sound id", () => {
  const port = new FakePort();
  const transport = makeTransport({ port });
  transport.setActiveCry(7);
  const frame = decodeFrame(port.writes.at(-1));
  assert.equal(frame.type, T.CONFIG);
  assert.equal(frame.seq, 0);
  assert.deepEqual([...frame.payload], [7]);
});

test("sendVolume writes a VOLUME frame with the configured volume (RM12)", () => {
  const port = new FakePort();
  const transport = makeTransport({ port });
  transport.sendVolume(70);
  const frame = decodeFrame(port.writes.at(-1));
  assert.equal(frame.type, T.VOLUME);
  assert.equal(frame.seq, 0);
  assert.deepEqual([...frame.payload], [70]);
});

test("playSound write error triggers reconnect (M8)", async () => {
  const port1 = new FakePort();
  const port2 = new FakePort();
  let attempts = 0;
  port1.writeError = new Error("disconnected");
  const transport = makeTransport({
    port: port1,
    openPort: async () => { attempts += 1; return port2; },
    reconnectDelayMs: 5,
  });

  transport.playSound(2);
  await waitFor(() => attempts === 1);
  assert.equal(attempts, 1);
  transport.close();
});

test("setActiveCry write error triggers reconnect (M8)", async () => {
  const port1 = new FakePort();
  const port2 = new FakePort();
  let attempts = 0;
  port1.writeError = new Error("disconnected");
  const transport = makeTransport({
    port: port1,
    openPort: async () => { attempts += 1; return port2; },
    reconnectDelayMs: 5,
  });

  transport.setActiveCry(7);
  await waitFor(() => attempts === 1);
  assert.equal(attempts, 1);
  transport.close();
});

test("sendVolume write error triggers reconnect with the same fire-and-forget guard (RM12)", async () => {
  const port1 = new FakePort();
  const port2 = new FakePort();
  let attempts = 0;
  port1.writeError = new Error("disconnected");
  const transport = makeTransport({
    port: port1,
    openPort: async () => { attempts += 1; return port2; },
    reconnectDelayMs: 5,
  });

  transport.sendVolume(70);
  await waitFor(() => attempts === 1);
  assert.equal(attempts, 1);
  transport.close();
});

test("RX recovers from a stray MAGIC with a bogus length and still parses later frames (H3)", () => {
  const port = new FakePort();
  const transport = makeTransport({ port });
  const buttons = [];
  transport.onButton((e) => buttons.push(e));

  // stray MAGIC + bogus huge length (0xFFFF), no real frame yet
  port.emitData(Uint8Array.from([MAGIC, T.BUTTON, 0x00, 0xff, 0xff]));
  // then a genuine BUTTON frame arrives
  port.emitData(encodeFrame({ type: T.BUTTON, seq: 9, payload: Uint8Array.from([1, 1]) }));

  assert.deepEqual(buttons, [{ key: "KEY", kind: "short" }]);
  transport.close();
});

test("RX resyncs past a bad-CRC frame to the next valid frame (H3)", () => {
  const port = new FakePort();
  const transport = makeTransport({ port });
  const buttons = [];
  transport.onButton((e) => buttons.push(e));

  const corrupt = Uint8Array.from(encodeFrame({ type: T.BUTTON, seq: 9, payload: Uint8Array.from([1, 1]) }));
  corrupt[corrupt.length - 1] ^= 0xff; // break the CRC
  port.emitData(corrupt);
  port.emitData(encodeFrame({ type: T.BUTTON, seq: 10, payload: Uint8Array.from([2, 2]) }));

  // corrupt frame dropped; the valid second frame is still delivered
  assert.deepEqual(buttons, [{ key: "BOOT", kind: "long" }]);
  transport.close();
});

test("a synchronous re-entrant listener does not double-dispatch a frame (H3 invariant)", () => {
  const port = new FakePort();
  const transport = makeTransport({ port });
  const buttons = [];
  let reentered = false;
  transport.onButton((e) => {
    buttons.push(e);
    if (!reentered) {
      reentered = true;
      // deliver a second, distinct frame synchronously from inside the listener
      port.emitData(encodeFrame({ type: T.BUTTON, seq: 11, payload: Uint8Array.from([2, 2]) }));
    }
  });

  port.emitData(encodeFrame({ type: T.BUTTON, seq: 9, payload: Uint8Array.from([1, 1]) }));

  assert.deepEqual(buttons, [{ key: "KEY", kind: "short" }, { key: "BOOT", kind: "long" }]);
  transport.close();
});

test("RX resyncs byte-wise past a frame with a corrupt length field (H3)", () => {
  const port = new FakePort();
  const transport = makeTransport({ port });
  const buttons = [];
  transport.onButton((e) => buttons.push(e));

  // valid BUTTON frame, but corrupt the LENGTH byte to a wrong-but-small value (magic intact, len<=512)
  const corrupt = Uint8Array.from(encodeFrame({ type: T.BUTTON, seq: 9, payload: Uint8Array.from([1, 1]) }));
  corrupt[3] = 3; // real len is 2; a whole-frame skip would mis-align by len -> swallow the next frame
  port.emitData(corrupt);
  port.emitData(encodeFrame({ type: T.BUTTON, seq: 10, payload: Uint8Array.from([2, 2]) }));

  // the corrupt frame fails CRC; byte-wise resync recovers the following valid frame
  assert.deepEqual(buttons, [{ key: "BOOT", kind: "long" }]);
  transport.close();
});

test("a deferred write error from an old port does not disconnect the reconnected port (M8 stale-callback)", async () => {
  const deferred = [];
  const port1 = new FakePort();
  // port1 defers its write callback instead of firing it synchronously
  port1.write = function write(bytes, callback) {
    this.writes.push(Uint8Array.from(bytes));
    if (callback) deferred.push(() => callback(new Error("late write error")));
    return true;
  };
  const port2 = new FakePort();
  let attempts = 0;
  const transport = makeTransport({
    port: port1,
    openPort: async () => { attempts += 1; return port2; },
    reconnectDelayMs: 5,
    timeoutMs: 50,
    maxRetries: 0,
  });

  transport.playSound(2);           // write deferred on port1
  port1.emitClose();                // disconnect -> reconnect to port2
  await waitFor(() => attempts === 1 && port2.listenerCount("data") > 0);

  deferred.forEach((fn) => fn());   // now fire the STALE port1 callback with an error

  // port2 must still be connected: a pushFrame writes to port2 and ACKs normally
  const sent = transport.pushFrame(Uint8Array.from([1]));
  assert.equal(port2.writes.length, 1);
  const frame = decodeFrame(port2.writes[0]);
  port2.emitData(encodeFrame({ type: T.ACK, seq: frame.seq, payload: Uint8Array.from([frame.seq]) }));
  assert.deepEqual(await sent, { ok: true, seq: 0 });
  transport.close();
});

test("close() survives a Poller 'error' emitted asynchronously by port.close (SIGTERM path)", async () => {
  const port = new FakePort();
  port.close = function close() {
    this.closed = true;
    // mimic @serialport/bindings-cpp Poller emitting after the removable listener is gone
    setImmediate(() => this.emit("error", new Error("Canceled")));
  };
  const transport = makeTransport({ port });

  transport.close(); // must not throw synchronously
  // the resident guard listener is never removed by detachPort
  assert.ok(port.listenerCount("error") >= 1);

  // the async Poller emission must not throw at node:events top level (would kill the process)
  await tick();
  await tick();
  assert.equal(port.closed, true);
});

test("a second 'error' after disconnect does not throw (post-detach)", async () => {
  const port = new FakePort();
  const transport = makeTransport({ port, openPort: async () => null, reconnectDelayMs: 5 });

  port.emitError(); // first error -> handleDisconnect removes the removable onError
  assert.ok(port.listenerCount("error") >= 1); // resident guard remains

  // a SECOND error on the now-detached old port must be swallowed by the resident guard
  port.emitError(new Error("Canceled"));
  await tick();
  transport.close();
});

test("'error' while connected still triggers the disconnect path (regression guard)", async () => {
  const port = new FakePort();
  const transport = makeTransport({ port, maxRetries: 0 });

  const result = transport.pushFrame(Uint8Array.from([9]));
  assert.equal(port.writes.length, 1);
  port.emitError(new Error("Canceled"));

  assert.deepEqual(await withTimeout(result, 20), { ok: false, disconnected: true });
});

test("createSerialTransport probe failure: async 'error' from close() does not throw", async () => {
  const created = [];
  class FakeSerialPort extends FakePort {
    constructor(options) {
      super();
      this.options = options;
      created.push(this);
    }
    open(callback) {
      callback(new Error("open failed"));
    }
    close() {
      this.closed = true;
      setImmediate(() => this.emit("error", new Error("Canceled")));
    }
    static async list() {
      return [{ path: "/dev/cu.usbmodem-probe", vendorId: "303A" }];
    }
  }

  const transport = await createSerialTransport({
    SerialPort: FakeSerialPort,
    path: "/dev/cu.usbmodem-probe",
  });

  assert.equal(transport, null); // open failed -> probe returns null
  assert.equal(created.length, 1);
  assert.ok(created[0].listenerCount("error") >= 1); // guarded right after construction

  await tick();
  await tick();
  assert.equal(created[0].closed, true);
});

test("close() swallows a synchronous throw from port.close (SIGTERM path)", () => {
  const port = new FakePort();
  port.close = () => { throw new Error("EBADF"); };
  const transport = makeTransport({ port });

  // A synchronous throw from close() must not escape close().
  assert.doesNotThrow(() => transport.close());
});

test("tryReconnect stopped-path swallows a synchronous throw from close() (SIGTERM race)", async () => {
  let resolveOpen;
  const gate = new Promise((r) => { resolveOpen = r; });
  let badClosed = false;
  const badPort = new FakePort();
  badPort.close = () => { badClosed = true; throw new Error("EBADF"); };
  const first = new FakePort();
  const transport = makeTransport({ port: first, openPort: () => gate, reconnectDelayMs: 1 });

  first.emitError();          // disconnect -> schedules reconnect
  await sleep(5);             // reconnect timer fires -> tryReconnect now awaiting gate
  transport.close();          // stopped = true
  resolveOpen(badPort);       // openPort resolves; tryReconnect hits `if (stopped)` -> badPort.close() throws
  await tick();               // must NOT surface an unhandled rejection
  await tick();

  assert.equal(badClosed, true); // the stopped-path close() was reached
});

class FakePort extends EventEmitter {
  writes = [];
  closed = false;
  writeError = null;

  write(bytes, callback) {
    this.writes.push(Uint8Array.from(bytes));
    callback?.(this.writeError);
    return true;
  }

  close() {
    this.closed = true;
  }

  emitData(bytes) {
    this.emit("data", Buffer.from(bytes));
  }

  emitClose() {
    this.emit("close");
  }

  emitError(error = new Error("serial error")) {
    this.emit("error", error);
  }
}

// battery omitted -> 3-byte payload, matching pre-battery firmware.
function sensorPayload(tempTenths, humidity, battery) {
  const payload = new Uint8Array(battery === undefined ? 3 : 4);
  const view = new DataView(payload.buffer);
  view.setInt16(0, tempTenths, true);
  payload[2] = humidity;
  if (battery !== undefined) payload[3] = battery;
  return payload;
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
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

async function withTimeout(promise, ms) {
  const timeout = Symbol("timeout");
  const result = await Promise.race([
    promise,
    sleep(ms).then(() => timeout),
  ]);
  assert.notEqual(result, timeout);
  return result;
}
