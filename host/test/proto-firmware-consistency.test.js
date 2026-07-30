import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_INBOUND_PAYLOAD, PROTO_VER, T } from "../src/transport/proto.js";
import { SND_SPECIES_BASE, SPECIES_SOUND_ORDER } from "../src/pet/cry-audio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mainCpp = readFileSync(resolve(root, "firmware", "main", "main.cpp"), "utf8");
const criesInc = readFileSync(resolve(root, "firmware", "main", "species_cries.inc"), "utf8");

test("firmware protocol opcodes match host proto constants (Batch G gate)", () => {
  const firmwareTypes = new Map(
    [...mainCpp.matchAll(/static constexpr uint8_t T_([A-Z_]+)\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*;/g)]
      .map(([, name, value]) => [name, Number.parseInt(value, 0)]),
  );

  for (const name of ["FRAME", "PLAY", "CONFIG", "TIME", "VOLUME", "HELLO", "BUTTON", "SENSOR", "ACK", "NACK", "AUTH", "RESYNC", "OFFLINE"]) {
    assert.equal(firmwareTypes.get(name), T[name], `T_${name}`);
  }
});

test("firmware protocol limits match host proto constants (Batch G gate)", () => {
  assert.equal(extractNumericConst("PROTO_VER"), PROTO_VER);
  assert.equal(extractNumericConst("MAX_INBOUND_PAYLOAD"), MAX_INBOUND_PAYLOAD);
});

// SND_COUNT used to be a numeric literal on both sides and was compared directly.
// It is derived on both sides now, so the useful comparison moved down a level: the
// generated species_cries.inc must agree with the seed JSON the host reads, because
// `cryAudioId` is soundBase + index into that JSON and the firmware's table is
// indexed the same way. If these ever disagree the host asks for one species' cry
// and the device plays another's, silently.
test("firmware sound table agrees with the host's cry list", () => {
  const base = Number(criesInc.match(/#define SND_SPECIES_BASE (\d+)/)?.[1]);
  const count = Number(criesInc.match(/#define SND_SPECIES_COUNT (\d+)/)?.[1]);
  assert.ok(Number.isInteger(base), "species_cries.inc must define SND_SPECIES_BASE");
  assert.ok(Number.isInteger(count), "species_cries.inc must define SND_SPECIES_COUNT");

  assert.equal(base, SND_SPECIES_BASE, "sound base must match seed/species-cries.json");
  assert.equal(count, SPECIES_SOUND_ORDER.length,
    "regenerate firmware/main/species_cries.inc: node scripts/gen-cries.mjs");

  // A sound id is one byte on the wire in PLAY and CONFIG.
  assert.ok(base + count <= 255, "the sound table cannot exceed 255 entries");
});

function extractNumericConst(name) {
  const match = mainCpp.match(new RegExp(`static constexpr (?:uint8_t|uint16_t|uint32_t|int|size_t)\\s+${name}\\s*=\\s*(0x[0-9A-Fa-f]+|\\d+)\\s*;`));
  assert.ok(match, `${name} must be a numeric static constexpr in firmware/main/main.cpp`);
  return Number.parseInt(match[1], 0);
}
