import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SND_SPECIES_BASE, SPECIES_SOUND_ORDER } from "./cry-audio.js";

// The capture screen's music. Same single-source rule as the cries: the ids are
// DERIVED from the seed on both sides -- here from its position in music.json,
// in the firmware from music.inc's SND_EXTRA_* offsets -- so neither side can
// drift into playing the wrong thing. proto.js deliberately holds no seed-backed
// ids (see the note at the top of it), which is why these live here.
//
// They sit ABOVE the 156 species cries rather than next to BUI/EVOLVE/HOUR:
// `cryAudioId` is soundBase + index, so inserting anything below the species
// range renumbers all of them at once.
const data = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../seed/music.json", import.meta.url)), "utf8"),
);

export const SND_EXTRA_BASE = SND_SPECIES_BASE + SPECIES_SOUND_ORDER.length;
export const EXTRA_SOUND_ORDER = data.extra.map((t) => t.key);

// The whole sound table the host believes the firmware carries. serial.js warns
// on a HELLO that reports fewer -- i.e. a device flashed before the music existed.
export const SND_TABLE_SIZE = SND_EXTRA_BASE + EXTRA_SOUND_ORDER.length;

function idOf(key) {
  const i = EXTRA_SOUND_ORDER.indexOf(key);
  if (i < 0) throw new Error(`seed/music.json has no track "${key}"`);
  return SND_EXTRA_BASE + i;
}

export const MUSIC = {
  // Loops on the device until STOP. Anything else queued for the speaker also
  // ends it, which is deliberate -- CAUGHT is meant to cut the music off, not
  // play over it.
  CAPTURE_BGM: idOf("capture_bgm"),
  CAPTURE_BGM_STOP: idOf("capture_bgm_stop"),
  CAPTURE_CAUGHT: idOf("capture_caught"),
};
