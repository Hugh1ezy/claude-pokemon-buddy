import { test } from "node:test";
import assert from "node:assert/strict";

import { renderFrame } from "../src/render/frame.js";
import { ENCOUNTER_BLINK_PERIOD, encounterBlinkOn } from "../src/render/layout.js";
import { LEFT_W } from "../src/render/palette.js";

// Left panel rows 3 and 4. Both are drawn into a band that was blank for the
// panel's whole life, so "did anything appear" is a real question the pixels
// are the only ones who can answer -- a wrong y or a missing model field
// misplaces or drops the row without throwing anywhere.
const ENC_BAND = { y0: 96, y1: 134 };
const DEX_BAND = { y0: 140, y1: 160 };

function model({ animPhase = 0, encounter = null, dex = null } = {}) {
  return {
    clock: "11:34",
    now: new Date(2026, 6, 30, 11, 34),
    p5h: 42,
    pweek: 7,
    weather: { cond: "多云", temp: 19, feels: 17, hi: 22, lo: 14, precip: 30, wind: 11, humidity: 64 },
    room: { t: 21, h: 55 },
    out: { t: 19, h: 64 },
    streak: 5,
    dex,
    encounter,
    buddy: {
      name: "Hughie", mood: "focus", level: 18, species: "bulbasaur",
      bond: 21.6, bondHearts: 3, expPct: 40, bubble: "BULBA", animPhase,
    },
  };
}

// Reads a horizontal band of the LEFT panel only, so the buddy's bob on the
// right cannot leak in and make a blank row look drawn. Returns both the ink
// count and an exact bit signature: the count answers "is anything there", and
// only the signature can tell 8 from 9, which carry identical ink in this font
// and made the first version of the duplicate-catch test pass on nothing.
async function bandOf(m, band) {
  const { bitmap } = await renderFrame(m);
  const rowBytes = Math.ceil(bitmap.w / 8);
  let ink = 0;
  const bits = [];
  for (let y = band.y0; y < band.y1; y += 1) {
    for (let x = 0; x < LEFT_W - 2; x += 1) {
      const on = (bitmap.bytes[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      bits.push(on);
      if (on) ink += 1;
    }
  }
  return { ink, sig: bits.join("") };
}

const inkInBand = async (m, band) => (await bandOf(m, band)).ink;
const sigOf = async (m, band) => (await bandOf(m, band)).sig;

test("row 3 stays blank when nothing is on offer", async () => {
  assert.equal(await inkInBand(model(), ENC_BAND), 0);
});

test("row 3 draws the encounter, and both blink phases keep it readable", async () => {
  const on = await inkInBand(model({ encounter: { species: "gastly", zh: "耿鬼" }, animPhase: 0 }), ENC_BAND);
  const off = await inkInBand(model({ encounter: { species: "gastly", zh: "耿鬼" }, animPhase: 3 }), ENC_BAND);

  assert.ok(on > 0, "the inverted phase must draw something");
  // The point of the outlined phase: a row that blinks to blank can be missed
  // entirely by looking at it during the off half, and this one has five
  // minutes to be noticed in.
  assert.ok(off > 0, "the off phase must still be visible, not blank");
  assert.notEqual(on, off, "the two phases must actually differ, or it is not blinking");
});

test("the species name is really rendered, not a fixed label", async () => {
  const a = await sigOf(model({ encounter: { species: "a", zh: "鲤鱼王" } }), ENC_BAND);
  const b = await sigOf(model({ encounter: { species: "b", zh: "耿鬼" } }), ENC_BAND);

  assert.notEqual(a, b, "two different names must not render identically");
});

test("row 4 is drawn whenever dex progress is in the model, and blank without it", async () => {
  const without = await inkInBand(model(), DEX_BAND);
  const with_ = await inkInBand(
    model({ dex: { capturedCount: 8, dexCaught: 12, dexTotal: 151, boxCount: 12 } }),
    DEX_BAND,
  );

  assert.equal(without, 0);
  assert.ok(with_ > 0);
});

test("row 4 shows the two counts separately, so a duplicate catch moves one and not the other", async () => {
  const base = { dexCaught: 12, dexTotal: 151, boxCount: 12 };
  const before = await sigOf(model({ dex: { ...base, capturedCount: 8 } }), DEX_BAND);
  const afterDuplicate = await sigOf(model({ dex: { ...base, capturedCount: 9 } }), DEX_BAND);
  const afterNewSpecies = await sigOf(
    model({ dex: { ...base, dexCaught: 13, capturedCount: 9 } }),
    DEX_BAND,
  );

  assert.notEqual(before, afterDuplicate, "捕捉 must move on a duplicate");
  assert.notEqual(afterDuplicate, afterNewSpecies, "图鉴 must move on a new species");
});

test("the blink alternates on a fixed period and a still frame shows the loud phase", () => {
  const half = ENCOUNTER_BLINK_PERIOD / 2;
  for (let i = 0; i < half; i += 1) assert.equal(encounterBlinkOn(i), true, `phase ${i}`);
  for (let i = half; i < ENCOUNTER_BLINK_PERIOD; i += 1) assert.equal(encounterBlinkOn(i), false, `phase ${i}`);
  assert.equal(encounterBlinkOn(ENCOUNTER_BLINK_PERIOD), true, "it must wrap");

  // paintFromDisk and the dashboard preview render without an animator.
  assert.equal(encounterBlinkOn(undefined), true);
});
