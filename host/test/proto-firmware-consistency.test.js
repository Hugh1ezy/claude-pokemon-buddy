import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_INBOUND_PAYLOAD, PROTO_VER, SND_COUNT, T } from "../src/transport/proto.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mainCpp = readFileSync(resolve(root, "firmware", "main", "main.cpp"), "utf8");

test("firmware protocol opcodes match host proto constants (Batch G gate)", () => {
  const firmwareTypes = new Map(
    [...mainCpp.matchAll(/static constexpr uint8_t T_([A-Z_]+)\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*;/g)]
      .map(([, name, value]) => [name, Number.parseInt(value, 0)]),
  );

  for (const name of ["FRAME", "PLAY", "CONFIG", "TIME", "VOLUME", "HELLO", "BUTTON", "SENSOR", "ACK", "NACK", "AUTH", "RESYNC"]) {
    assert.equal(firmwareTypes.get(name), T[name], `T_${name}`);
  }
});

test("firmware protocol limits match host proto constants (Batch G gate)", () => {
  assert.equal(extractNumericConst("PROTO_VER"), PROTO_VER);
  assert.equal(extractNumericConst("SND_COUNT"), SND_COUNT);
  assert.equal(extractNumericConst("MAX_INBOUND_PAYLOAD"), MAX_INBOUND_PAYLOAD);
});

function extractNumericConst(name) {
  const match = mainCpp.match(new RegExp(`static constexpr (?:uint8_t|uint16_t|uint32_t|int|size_t)\\s+${name}\\s*=\\s*(0x[0-9A-Fa-f]+|\\d+)\\s*;`));
  assert.ok(match, `${name} must be a numeric static constexpr in firmware/main/main.cpp`);
  return Number.parseInt(match[1], 0);
}
