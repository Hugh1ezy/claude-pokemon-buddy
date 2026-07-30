import { test } from "node:test";
import assert from "node:assert/strict";

import { SND_SPECIES_BASE, SPECIES_SOUND_ORDER, cryAudioId } from "../src/pet/cry-audio.js";

test("SND_SPECIES_BASE is 3 (after BUI/EVOLVE/HOUR)", () => {
  assert.equal(SND_SPECIES_BASE, 3);
});

// Pinned as an invariant rather than as a count. This asserted exactly 18 and had
// to be edited the moment a cry was added, which is the wrong thing to notice --
// what matters is that ids stay contiguous from the base and unique, whatever the
// length is. The first entry's id is pinned separately below, and that IS a
// constant worth freezing: it is the ABI the firmware's table is built against.
test("species map to contiguous, unique ids from the sound base", () => {
  const ids = SPECIES_SOUND_ORDER.map((s) => cryAudioId(s));
  assert.equal(ids.length, SPECIES_SOUND_ORDER.length);
  assert.deepEqual(ids, Array.from({ length: ids.length }, (_, i) => ids[0] + i));
  assert.equal(new Set(ids).size, ids.length);
});

test("cryAudioId follows JSON order (eevee=3, blastoise=20)", () => {
  assert.equal(cryAudioId("eevee"), 3);
  assert.equal(cryAudioId("blastoise"), 20);
});

test("cryAudioId returns null for unknown species", () => {
  assert.equal(cryAudioId("不存在"), null);
  assert.equal(cryAudioId(undefined), null);
});
