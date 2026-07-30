export const MAGIC = 0xA5;
export const PROTO_VER = 1;
// NOTE: the expected sound-table size is NOT here. It is derived in serial.js from
// seed/species-cries.json, because a literal in this file sat at 21 while the cry
// table grew to 156 and silently disabled the mismatch warning it fed. This module
// stays free of seed-data dependencies so tests can import it on its own.
export const MAX_INBOUND_PAYLOAD = 30016;
export const T = {
  FRAME: 0x01,
  SOUND_LOAD: 0x02,
  PLAY: 0x03,
  CONFIG: 0x04,
  TIME: 0x05,
  VOLUME: 0x25,
  HELLO: 0x81,
  BUTTON: 0x82,
  SENSOR: 0x83,
  ACK: 0x84,
  NACK: 0x85,
  AUTH: 0x86,
  RESYNC: 0x87,
};

// Sound ids carried in a PLAY frame's payload[0]. Must match the firmware's
// SND_* constants (main.cpp): 0=idle cry, 1=evolution fanfare, 2=hour chime.
export const SOUND = { BUI: 0, EVOLVE: 1, HOUR: 2 };

export function rleEncode(b) {
  const o = [];
  for (let i = 0; i < b.length;) {
    let v = b[i];
    let n = 1;
    while (i + n < b.length && b[i + n] === v && n < 255) n += 1;
    o.push(n, v);
    i += n;
  }
  return Uint8Array.from(o);
}

export function rleDecode(b) {
  const o = [];
  for (let i = 0; i < b.length; i += 2) {
    const n = b[i];
    const v = b[i + 1];
    for (let k = 0; k < n; k += 1) o.push(v);
  }
  return Uint8Array.from(o);
}

function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i += 1) {
    c ^= b[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

export function encodeFrame({ type, seq, payload }) {
  const len = payload.length;
  if (len > 0xffff) throw new RangeError("payload length exceeds 65535 bytes");
  const head = Uint8Array.from([MAGIC, type, seq, len & 255, (len >> 8) & 255]);
  const body = new Uint8Array(head.length + len);
  body.set(head);
  body.set(payload, head.length);
  const c = crc32(body);
  const out = new Uint8Array(body.length + 4);
  out.set(body);
  out.set([c & 255, (c >> 8) & 255, (c >> 16) & 255, (c >> 24) & 255], body.length);
  return out;
}

export function decodeFrame(f) {
  if (f[0] !== MAGIC) throw new Error("magic");
  const len = f[3] | (f[4] << 8);
  const end = 5 + len;
  const got = (f[end] | (f[end + 1] << 8) | (f[end + 2] << 16) | (f[end + 3] << 24)) >>> 0;
  if (crc32(f.slice(0, end)) !== got) throw new Error("crc");
  return { type: f[1], seq: f[2], payload: f.slice(5, end) };
}
