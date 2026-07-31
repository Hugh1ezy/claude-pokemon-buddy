import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { generateInc, noteHz, noteMs, resolveScore } from "../scripts/gen-music.mjs";

const data = JSON.parse(
  readFileSync(fileURLToPath(new URL("../seed/music.json", import.meta.url)), "utf8"),
);

test("note names resolve to equal-tempered pitches", () => {
  assert.equal(noteHz("A4"), 440);
  assert.equal(noteHz("A5"), 880);
  assert.equal(noteHz("D5"), 587.33);
  assert.equal(noteHz("A#5"), 932.33);
  assert.equal(noteHz("Bb5"), 932.33, "flats and sharps must land on the same key");
  // A rest is f0 = 0, which is exactly what synth_tone reads as a silent gap --
  // not a very low note, and not a separate field.
  assert.equal(noteHz("-"), 0);
  assert.throws(() => noteHz("H4"), /bad note name/);
});

test("durations come from the tempo or from an explicit ms, and nothing else", () => {
  const whole = 1600;               // 150bpm: a whole note is 4 beats
  assert.equal(noteMs("D5/8", whole), 200);
  assert.equal(noteMs("D5/4", whole), 400);
  assert.equal(noteMs("F6:700", whole), 700);
  assert.throws(() => noteMs("F6", whole), /bad duration/);
});

test("every bar of the loop is the same length", () => {
  const [bgm] = resolveScore(data);
  assert.equal(bgm.kind, "loop");
  const bars = bgm.phrases.map((p) => p.reduce((t, n) => t + n.ms, 0));
  // A short bar would not sound like a mistake in isolation -- it would sound
  // like the tune rushing, once every twelve seconds, which is a miserable thing
  // to debug by ear. The buffer is also sized to the longest phrase, so a bar
  // that quietly grew is a PSRAM cost nobody asked for.
  assert.deepEqual(new Set(bars), new Set([1600]), `bars: ${bars.join(", ")}`);
});

test("the control id carries no audio", () => {
  const stop = resolveScore(data).find((t) => t.key === "capture_bgm_stop");
  assert.equal(stop.kind, "control");
  assert.equal(stop.notes, undefined);
  assert.equal(stop.phrases, undefined);
});

test("generated inc declares the extra count, offsets and one array per bar", () => {
  const inc = generateInc(data);
  // The offsets are frozen deliberately -- they are the ABI against a flashed
  // image. COUNT is derived, because it moves every time a track is added and a
  // literal here only ever fails with "the number changed". New tracks go on the
  // END for the same reason: reordering the seed silently repoints every id.
  assert.match(inc, new RegExp(`#define SND_EXTRA_COUNT ${data.extra.length}\\b`));
  assert.match(inc, /#define SND_EXTRA_BGM_CAPTURE 0/);
  assert.match(inc, /#define SND_EXTRA_BGM_STOP 1/);
  assert.match(inc, /#define SND_EXTRA_CAUGHT 2/);
  assert.match(inc, /#define SND_EXTRA_EVOLUTION 3/);
  assert.match(inc, /static constexpr int BGM_CAPTURE_PHRASE_COUNT = 8;/);
  assert.equal((inc.match(/static const Note BGM_CAPTURE_P\d+\[\]/g) ?? []).length, 8);
  // The .inc is #included into a translation unit; the seed's Chinese titles stay
  // out of it so the build never depends on comment encoding.
  assert.ok(!/[^\x00-\x7f]/.test(inc), "generated music.inc must be pure ASCII");
});

test("committed music.inc matches regenerated output (no drift)", () => {
  const committed = readFileSync(
    fileURLToPath(new URL("../../firmware/main/music.inc", import.meta.url)), "utf8");
  assert.equal(committed, generateInc(data));
});
