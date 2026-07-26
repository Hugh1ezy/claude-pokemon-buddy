import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { diffRect } from "./diff.js";
import { createMockTransport } from "./mock.js";
import { rleEncode } from "./proto.js";
import { createSerialTransport, DEFAULT_RECONNECT_DELAY_MS } from "./serial.js";

let loggedMockFallback = false;

export async function createTransport({
  framePath = "out/frame.png",
  serialTransportFactory = createSerialTransport,
  mockFactory = createMockTransport,
  logger = console,
  ...serialOptions
} = {}) {
  const events = new EventEmitter();
  let inner = null;
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

  const serial = await serialTransportFactory(serialOptions);
  if (serial) {
    attachSerial(serial);
    await chain;
  } else {
    logMockFallback(logger);
    attachMock(mockFactory({ framePath }));
    scheduleProbe();
  }

  return {
    push,
    pushFrame,
    playSound,
    setActiveCry,
    sendVolume,
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

    let next = null;
    try {
      next = await serialTransportFactory(serialOptions);
    } catch {
      next = null;
    }

    if (closed || inner) {
      closeQuietly(next);
      return;
    }
    if (!next) {
      scheduleProbe();
      return;
    }

    attachSerial(next);
    logger?.warn?.("ESP serial port detected; upgrading mock transport to serial");
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

  function attachSerial(next) {
    detachInner();
    inner = next;
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
    ];
    detachInner = () => {
      offs.forEach((off) => off?.());
      detachInner = () => {};
    };
    replay();
    events.emit("reconnect");
    redrawLastFrame();
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
    return inner ? "serial" : "mock";
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
