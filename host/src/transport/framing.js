// Transport-agnostic byte-stream framing: turns an arbitrary byte stream (serial
// port data, TCP socket data, ...) into decoded protocol frames. No I/O here —
// every transport (serial.js, wifi.js) owns its own `rx` buffer and feeds bytes
// in via appendBytes/pumpFrames, so this logic is shared instead of duplicated.
import { decodeFrame, MAGIC } from "./proto.js";

// Firmware uplink payloads are <=255 (uint8 len); bound rejects noise/desync.
export const MAX_RX_PAYLOAD = 512;

export const BUTTON_KEYS = new Map([
  [1, "KEY"],
  [2, "BOOT"],
]);
export const BUTTON_KINDS = new Map([
  [1, "short"],
  [2, "long"],
  [3, "double"],
  [4, "down"],
  [5, "up"],
]);

export function appendBytes(rx, chunk) {
  const incoming = Uint8Array.from(chunk);
  const out = new Uint8Array(rx.length + incoming.length);
  out.set(rx);
  out.set(incoming, rx.length);
  return out;
}

// `state` is a mutable holder ({ rx: Uint8Array }) owned by the caller.
// Consumes as many complete, valid frames as state.rx currently holds,
// updating state.rx in place BEFORE calling onFrame(frame) for each one —
// not batched, not returned at the end. onFrame can synchronously trigger
// more bytes to arrive on the same state (e.g. a button listener that
// re-enters the transport's data handler); because state.rx is updated
// immediately rather than via a local copy returned later, that re-entrant
// call sees the already-consumed buffer and can't re-process this frame.
export function pumpFrames(state, onFrame) {
  while (state.rx.length >= 5) {
    const magicOffset = state.rx.indexOf(MAGIC);
    if (magicOffset < 0) {
      state.rx = new Uint8Array(0);
      return;
    }
    if (magicOffset > 0) state.rx = state.rx.slice(magicOffset);
    if (state.rx.length < 5) return;

    const len = state.rx[3] | (state.rx[4] << 8);
    if (len > MAX_RX_PAYLOAD) {
      // Bogus length (line noise / desync) -> drop this MAGIC byte and rescan.
      state.rx = state.rx.slice(1);
      continue;
    }

    const frameLen = 5 + len + 4;
    if (state.rx.length < frameLen) return;

    const frameBytes = state.rx.slice(0, frameLen);
    let frame;
    try {
      frame = decodeFrame(frameBytes);
    } catch {
      // Bad CRC / corrupt -> advance one byte and resync to the next MAGIC.
      state.rx = state.rx.slice(1);
      continue;
    }
    state.rx = state.rx.slice(frameLen); // consume BEFORE dispatch so a re-entrant read can't re-process this frame
    onFrame(frame);
  }
}

export function ackSeq(frame) {
  return frame.payload.length > 0 ? frame.payload[0] : frame.seq;
}

export function parseButton(payload) {
  if (payload.length < 2) return null;
  return {
    key: BUTTON_KEYS.get(payload[0]) ?? `KEY_${payload[0]}`,
    kind: BUTTON_KINDS.get(payload[1]) ?? `evt_${payload[1]}`,
  };
}

export function parseHello(payload) {
  if (payload.length < 2) return null;
  return {
    protoVer: payload[0],
    sndCount: payload[1],
  };
}

export function parseSensor(payload) {
  if (payload.length < 3) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    t: view.getInt16(0, true) / 10,
    h: payload[2],
  };
}

export function volumeByte(value) {
  const volume = Number(value);
  if (!Number.isFinite(volume)) return 0;
  return Math.max(0, Math.min(100, Math.trunc(volume)));
}
