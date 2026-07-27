import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeFrame, encodeFrame, T } from "../src/transport/proto.js";
import { createWifiTransport, findWifiHost } from "../src/transport/wifi.js";

test("findWifiHost resolves the discovered service's host and port", async () => {
  const BonjourImpl = bonjourStub({ service: { referer: { address: "192.168.1.42" }, port: 7311 } });

  assert.deepEqual(await findWifiHost({ BonjourImpl, timeoutMs: 200 }), { host: "192.168.1.42", port: 7311 });
});

test("findWifiHost resolves null when nothing answers before the timeout", async () => {
  const BonjourImpl = bonjourStub({ service: null });

  assert.equal(await findWifiHost({ BonjourImpl, timeoutMs: 20 }), null);
});

test("createWifiTransport throws without a pairing token", async () => {
  await assert.rejects(() => createWifiTransport({ host: "192.168.1.42", port: 7311 }), /pairing token/);
});

test("createWifiTransport sends AUTH with the token as the first write on connect", async () => {
  const sockets = [];
  const netConnect = autoConnectStub(sockets);

  const transport = await createWifiTransport({
    netConnect,
    host: "192.168.1.42",
    port: 7311,
    token: "s3cr3t",
  });

  assert.ok(transport);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].writes.length, 1);
  const authFrame = decodeFrame(sockets[0].writes[0]);
  assert.equal(authFrame.type, T.AUTH);
  assert.equal(Buffer.from(authFrame.payload).toString("utf8"), "s3cr3t");
  transport.close();
});

test("createWifiTransport falls back to mDNS discovery when host/port aren't given", async () => {
  const sockets = [];
  const netConnect = autoConnectStub(sockets);
  const BonjourImpl = bonjourStub({ service: { addresses: ["192.168.1.7"], port: 7311 } });

  const transport = await createWifiTransport({ netConnect, BonjourImpl, token: "s3cr3t", discoverTimeoutMs: 200 });

  assert.ok(transport);
  transport.close();
});

test("createWifiTransport returns null when discovery finds nothing", async () => {
  const BonjourImpl = bonjourStub({ service: null });

  const transport = await createWifiTransport({ BonjourImpl, token: "s3cr3t", discoverTimeoutMs: 20 });
  assert.equal(transport, null);
});

test("createWifiTransport returns null when the socket connect times out", async () => {
  const netConnect = () => new FakeSocket(); // never emits "connect" or "error"

  const transport = await createWifiTransport({
    netConnect,
    host: "192.168.1.42",
    port: 7311,
    token: "s3cr3t",
    connectTimeoutMs: 20,
  });
  assert.equal(transport, null);
});

test("createWifiTransport returns null when the socket errors before connecting", async () => {
  const netConnect = () => {
    const socket = new FakeSocket();
    setImmediate(() => socket.emitError());
    return socket;
  };

  const transport = await createWifiTransport({
    netConnect,
    host: "192.168.1.42",
    port: 7311,
    token: "s3cr3t",
    connectTimeoutMs: 200,
  });
  assert.equal(transport, null);
});

test("a remembered address is tried before browsing, and mDNS is never queried", async () => {
  const sockets = [];
  const netConnect = autoConnectStub(sockets);
  let browsed = false;
  const BonjourImpl = class { find() { browsed = true; return { stop() {} }; } destroy() {} };

  const transport = await createWifiTransport({
    netConnect,
    BonjourImpl,
    token: "s3cr3t",
    addressCache: memoryCache({ host: "192.168.1.138", port: 7311 }),
  });

  assert.ok(transport);
  assert.equal(browsed, false, "a working remembered address must skip discovery entirely");
  transport.close();
});

test("a stale remembered address falls back to mDNS and the new one replaces it", async () => {
  const attempts = [];
  const netConnect = (target) => {
    attempts.push(target);
    const socket = new FakeSocket();
    // The remembered host has moved; only the discovered one answers.
    if (target.host === "192.168.1.7") setImmediate(() => socket.emit("connect"));
    else setImmediate(() => socket.emitError());
    return socket;
  };
  const BonjourImpl = bonjourStub({ service: { addresses: ["192.168.1.7"], port: 7311 } });
  const cache = memoryCache({ host: "192.168.1.99", port: 7311 });

  const transport = await createWifiTransport({
    netConnect, BonjourImpl, token: "s3cr3t", discoverTimeoutMs: 200, cachedConnectTimeoutMs: 20,
    addressCache: cache,
  });

  assert.ok(transport);
  assert.deepEqual(attempts.map((a) => a.host), ["192.168.1.99", "192.168.1.7"]);
  assert.deepEqual(cache.read(), { host: "192.168.1.7", port: 7311 });
  transport.close();
});

test("a remembered address is not written back until the connection actually works", async () => {
  const BonjourImpl = bonjourStub({ service: { addresses: ["192.168.1.7"], port: 7311 } });
  const cache = memoryCache(null);

  const transport = await createWifiTransport({
    netConnect: () => new FakeSocket(), // never connects
    BonjourImpl, token: "s3cr3t", discoverTimeoutMs: 200, connectTimeoutMs: 20,
    addressCache: cache,
  });

  assert.equal(transport, null);
  assert.equal(cache.read(), null);
});

test("a corrupt cache entry is ignored rather than tried", async () => {
  const attempts = [];
  const netConnect = (target) => {
    attempts.push(target);
    const socket = new FakeSocket();
    setImmediate(() => socket.emit("connect"));
    return socket;
  };
  const BonjourImpl = bonjourStub({ service: { addresses: ["192.168.1.7"], port: 7311 } });

  for (const bad of [{ host: "", port: 7311 }, { host: "x", port: 0 }, { host: "x" }, {}]) {
    attempts.length = 0;
    const transport = await createWifiTransport({
      netConnect, BonjourImpl, token: "s3cr3t", discoverTimeoutMs: 200,
      addressCache: memoryCache(bad),
    });
    assert.deepEqual(attempts.map((a) => a.host), ["192.168.1.7"], `bad entry ${JSON.stringify(bad)}`);
    transport?.close();
  }
});

test("pushFrame over the wifi-connected socket resolves on ACK (reuses makeTransport's queueing)", async () => {
  const sockets = [];
  const netConnect = autoConnectStub(sockets);

  const transport = await createWifiTransport({ netConnect, host: "192.168.1.42", port: 7311, token: "s3cr3t" });
  const socket = sockets[0];

  const sent = transport.pushFrame(Uint8Array.from([9, 9]));
  // writes[0] is the AUTH frame sent on connect; the FRAME write follows it.
  assert.equal(socket.writes.length, 2);
  const frame = decodeFrame(socket.writes[1]);
  assert.equal(frame.type, T.FRAME);

  socket.emitData(encodeFrame({ type: T.ACK, seq: frame.seq, payload: Uint8Array.from([frame.seq]) }));
  assert.deepEqual(await sent, { ok: true, seq: frame.seq });
  transport.close();
});

class FakeSocket extends EventEmitter {
  writes = [];
  destroyed = false;

  write(bytes, callback) {
    this.writes.push(Uint8Array.from(bytes));
    callback?.(null);
    return true;
  }

  destroy() {
    this.destroyed = true;
  }

  emitData(bytes) {
    this.emit("data", Buffer.from(bytes));
  }

  emitError(error = new Error("socket error")) {
    this.emit("error", error);
  }
}

function autoConnectStub(sockets) {
  return () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    setImmediate(() => socket.emit("connect"));
    return socket;
  };
}

function memoryCache(initial) {
  let value = initial;
  return {
    read: () => value,
    write: (next) => { value = next; },
  };
}

function bonjourStub({ service }) {
  return class StubBonjour {
    find(_opts, onFound) {
      let stopped = false;
      if (service) setImmediate(() => { if (!stopped) onFound(service); });
      return { stop() { stopped = true; } };
    }
    destroy() {}
  };
}
