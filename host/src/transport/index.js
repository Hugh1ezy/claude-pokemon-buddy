import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { diffRect } from "./diff.js";
import { createMockTransport } from "./mock.js";
import { rleEncode } from "./proto.js";
import { createSerialTransport, DEFAULT_RECONNECT_DELAY_MS } from "./serial.js";
import { createWifiTransport } from "./wifi.js";

let loggedMockFallback = false;

export async function createTransport({
  framePath = "out/frame.png",
  serialTransportFactory = createSerialTransport,
  wifiTransportFactory = createWifiTransport,
  mockFactory = createMockTransport,
  logger = console,
  // { enabled, token, host?, port? } — host/port pin a known address; omit them
  // to discover the device via mDNS. USB stays the priority path: wifi is only
  // tried when no serial device is found, both on startup and on every probe.
  wifi = null,
  ...serialOptions
} = {}) {
  const events = new EventEmitter();
  let inner = null;
  let innerKind = null;
  let mock = null;
  let previousBytes = null;
  let lastFrame = null;
  let lastActiveCry = null;
  let lastVolume = null;
  let detachInner = () => {};
  let probeTimer = null;
  let closed = false;
  let chain = Promise.resolve();
  const probeDelayMs = serialOptions.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const wifiEnabled = Boolean(wifi?.enabled && wifi?.token);
  const wifiOptions = wifiEnabled ? { token: wifi.token, host: wifi.host, port: wifi.port, logger } : null;

  const initial = await connectAny();
  if (initial) {
    attachInner(initial.next, initial.kind);
    await chain;
  } else {
    logMockFallback(logger);
    attachMock(mockFactory({ framePath }));
    scheduleProbe();
  }

  async function connectAny() {
    const serial = await serialTransportFactory(serialOptions);
    if (serial) return { next: serial, kind: "serial" };
    if (!wifiEnabled) return null;
    const w = await wifiTransportFactory(wifiOptions).catch(() => null);
    return w ? { next: w, kind: "wifi" } : null;
  }

  return {
    push,
    pushFrame,
    playSound,
    setActiveCry,
    sendVolume,
    sendTime,
    onButton,
    onSensor,
    onReconnect,
    feedSensor,
    getHello,
    injectButton,
    getKind,
    close,
  };

  function scheduleProbe() {
    if (closed || inner || probeTimer) return;
    probeTimer = setTimeout(runProbe, probeDelayMs);
  }

  async function runProbe() {
    probeTimer = null;
    if (closed || inner) return;

    const found = await connectAny().catch(() => null);

    if (closed || inner) {
      closeQuietly(found?.next);
      return;
    }
    if (!found) {
      scheduleProbe();
      return;
    }

    attachInner(found.next, found.kind);
    logger?.warn?.(`ESP ${found.kind} device detected; upgrading mock transport to ${found.kind}`);
  }

  function attachMock(next) {
    detachInner();
    mock = next;
    const off = next.onButton?.((event) => events.emit("button", event));
    detachInner = () => {
      off?.();
      detachInner = () => {};
    };
  }

  function attachInner(next, kind) {
    detachInner();
    inner = next;
    innerKind = kind;
    previousBytes = null;
    const offs = [
      next.onButton?.((event) => events.emit("button", event)),
      next.onSensor?.((event) => events.emit("sensor", event)),
      next.onReconnect?.(() => {
        previousBytes = null;
        replay();
        events.emit("reconnect");
        redrawLastFrame();
      }),
      // A transport that was already attached (not the initial cold-start
      // miss) can still be lost later -- e.g. USB unplugged mid-session.
      // serial.js's own internal reconnect only knows how to retry the SAME
      // kind of transport (re-scan for a serial port), so without this the
      // orchestrator would never learn the connection is gone and would
      // never fall back to mock/re-probe wifi. Treating a warm loss the same
      // as "never found" here is what lets wifi actually kick in when USB
      // disappears instead of only on a cold host start.
      next.onDisconnect?.(() => handleInnerLost(next)),
    ];
    detachInner = () => {
      offs.forEach((off) => off?.());
      detachInner = () => {};
    };
    replay();
    events.emit("reconnect");
    redrawLastFrame();
  }

  // `lost` guards against a stale callback firing after `inner` has already
  // moved on for some other reason (e.g. close() ran first).
  function handleInnerLost(lost) {
    if (closed || inner !== lost) return;
    inner = null;
    innerKind = null;
    closeQuietly(lost); // stops its internal reconnect loop (e.g. serial.js re-scanning for the same port forever)
    attachMock(mockFactory({ framePath }));
    scheduleProbe(); // tries serial again, then wifi if enabled -- same path a cold start takes
  }

  function replay() {
    if (lastActiveCry != null) inner?.setActiveCry?.(lastActiveCry);
    if (lastVolume != null) inner?.sendVolume?.(lastVolume);
  }

  function redrawLastFrame() {
    chain = chain.then(async () => {
      if (closed || !inner || previousBytes || !lastFrame) return; // 已有新帧上过线则无需补
      await doPush(lastFrame);
    }).then(() => {}, () => {});
  }

  async function doPush(frame) {
    if (!inner) {
      const result = await mock.push(frame?.pngBuffer ?? frame);
      if (result?.ok && frame?.bitmap) lastFrame = frame;
      return result;
    }

    const { pngBuffer, bitmap } = frame ?? {};
    if (!bitmap) throw new Error("bitmap is required");
    writePreview(framePath, pngBuffer);
    const rect = diffRect(previousBytes, bitmap.bytes, bitmap.w, bitmap.h);
    if (!rect) {
      lastFrame = frame;
      return { ok: true, skipped: true };
    }
    const result = await inner.pushFrame(encodeDirtyPayload(rect));
    if (result?.ok) {
      previousBytes = Uint8Array.from(bitmap.bytes);
      lastFrame = frame;
    }
    return result;
  }

  function push(frame) {
    const run = chain.then(() => doPush(frame));
    chain = run.then(() => {}, () => {}); // 保持链活，吞错不阻断后续
    return run;
  }

  function pushFrame(payload) {
    if (!inner) return Promise.resolve({ ok: false, disconnected: true });
    return inner.pushFrame(payload);
  }

  function playSound(id) {
    return inner?.playSound?.(id);
  }

  function setActiveCry(id) {
    lastActiveCry = id & 0xff;
    return inner?.setActiveCry?.(lastActiveCry);
  }

  function sendVolume(volume) {
    lastVolume = volumeByte(volume);
    return inner?.sendVolume?.(lastVolume);
  }

  // No replay-on-reconnect needed (unlike cry/volume, which are state) --
  // this is periodic, sent fresh every tick, and the device free-runs its
  // own clock between syncs regardless of when the last one landed.
  function sendTime(hour, minute) {
    return inner?.sendTime?.(hour, minute);
  }

  function onButton(callback) {
    events.on("button", callback);
    return () => events.off("button", callback);
  }

  function onSensor(callback) {
    events.on("sensor", callback);
    return () => events.off("sensor", callback);
  }

  function onReconnect(callback) {
    events.on("reconnect", callback);
    return () => events.off("reconnect", callback);
  }

  function feedSensor() {
    return inner ? inner.feedSensor?.() : mock?.feedSensor?.();
  }

  function getHello() {
    return inner?.getHello?.() ?? null;
  }

  function injectButton(key, kind) {
    return mock?.injectButton?.(key, kind);
  }

  function getKind() {
    return inner ? innerKind : "mock";
  }

  function close() {
    closed = true;
    clearTimeout(probeTimer);
    probeTimer = null;
    detachInner();
    closeQuietly(inner);
  }
}

export function encodeDirtyPayload(rect) {
  const rle = rleEncode(rect.bytes);
  const payload = new Uint8Array(8 + rle.length);
  const view = new DataView(payload.buffer);
  view.setUint16(0, rect.x, true);
  view.setUint16(2, rect.y, true);
  view.setUint16(4, rect.w, true);
  view.setUint16(6, rect.h, true);
  payload.set(rle, 8);
  return payload;
}

function logMockFallback(logger) {
  if (loggedMockFallback) return;
  loggedMockFallback = true;
  logger?.warn?.("ESP serial port not found; using mock transport");
}

function closeQuietly(transport) {
  try {
    transport?.close?.();
  } catch {
    // 关停竞态中的同步 close 错误不应逃逸。
  }
}

function writePreview(framePath, pngBuffer) {
  if (!framePath || !pngBuffer) return;
  mkdirSync(dirname(framePath), { recursive: true });
  writeFileSync(framePath, pngBuffer);
}

function volumeByte(value) {
  const volume = Number(value);
  if (!Number.isFinite(volume)) return 0;
  return Math.max(0, Math.min(100, Math.trunc(volume)));
}
