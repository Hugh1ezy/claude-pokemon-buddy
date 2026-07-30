import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { generateInc } from "../scripts/gen-cries.mjs";

const data = JSON.parse(
  readFileSync(fileURLToPath(new URL("../seed/species-cries.json", import.meta.url)), "utf8"),
);

test("generated inc declares base/count and one table per species", () => {
  const inc = generateInc(data);
  // BASE is frozen deliberately -- it is the ABI boundary against the firmware's
  // three system sounds. COUNT is derived, because it changes every time a cry is
  // added and asserting a literal here only ever produces a failure that means
  // "the number changed", not "something is wrong".
  assert.match(inc, /#define SND_SPECIES_BASE 3/);
  assert.match(inc, new RegExp(`#define SND_SPECIES_COUNT ${data.species.length}\\b`));
  assert.match(inc, /SPECIES_CRY_0\[\] = \{ \{520\.f, 780\.f, 110\}/); // eevee, id 3, unchanged
  assert.equal((inc.match(/static const Note SPECIES_CRY_\d+\[\]/g) ?? []).length, data.species.length);
});

test("committed species_cries.inc matches regenerated output (no drift)", () => {
  const inc = generateInc(data);
  const committed = readFileSync(
    fileURLToPath(new URL("../../firmware/main/species_cries.inc", import.meta.url)), "utf8");
  assert.equal(committed, inc);
});
