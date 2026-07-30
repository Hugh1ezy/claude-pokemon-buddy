import { test } from "node:test";
import assert from "node:assert/strict";

import { renderFrame } from "../src/render/frame.js";
import {
  DATE_PX,
  DATE_ROW_LEFT,
  DATE_ROW_RIGHT,
  ENCOUNTER_BLINK_PERIOD,
  WEEKDAY_PX,
  encounterBlinkOn,
} from "../src/render/layout.js";
import { LEFT_W } from "../src/render/palette.js";

// Left panel rows 3 and 4. Both are drawn into a band that was blank for the
// panel's whole life, so "did anything appear" is a real question the pixels
// are the only ones who can answer -- a wrong y or a missing model field
// misplaces or drops the row without throwing anywhere.
const ENC_BAND = { y0: 96, y1: 134 };
const DEX_BAND = { y0: 140, y1: 160 };

function model({ animPhase = 0, encounter = null, dex = null, place = null } = {}) {
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
    place,
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

test("row 3 stays blank when there is neither an offer nor a known place", async () => {
  assert.equal(await inkInBand(model(), ENC_BAND), 0);
});

test("row 3 shows the place message when nothing is on offer", async () => {
  const work = await sigOf(model({ place: "work" }), ENC_BAND);
  const home = await sigOf(model({ place: "home" }), ENC_BAND);

  assert.notEqual(work, "0".repeat(work.length), "work must draw something");
  assert.notEqual(home, "0".repeat(home.length), "home must draw something");
  assert.notEqual(work, home, "the two places must not show the same message");
});

// Guessing is worse than silence: the wrong guess tells him to rest at home
// while he is sitting at his desk.
test("an unknown place draws nothing rather than guessing one", async () => {
  for (const place of [null, undefined, "", "cafe", "WORK", 7]) {
    assert.equal(await inkInBand(model({ place }), ENC_BAND), 0, `place ${JSON.stringify(place)}`);
  }
});

test("an offer replaces the place message and never names the species", async () => {
  const idle = await sigOf(model({ place: "work" }), ENC_BAND);
  const a = await sigOf(model({ place: "work", encounter: { species: "gastly" } }), ENC_BAND);
  const b = await sigOf(model({ place: "home", encounter: { species: "magikarp" } }), ENC_BAND);

  assert.notEqual(a, idle, "an offer must take the row over from the place message");
  // The species is the capture screen's to reveal. Two different species at the
  // same blink phase must render identically, or the row is leaking it.
  assert.equal(a, b, "row 3 must not vary with the species -- or the place, once an offer is up");
});

test("the blink changes weight without moving the text", async () => {
  const heavy = await bandOf(model({ encounter: { species: "gastly" }, animPhase: 0 }), ENC_BAND);
  const light = await bandOf(model({ encounter: { species: "gastly" }, animPhase: 3 }), ENC_BAND);

  assert.ok(light.ink > 0, "the light phase must still be visible, not blank");
  assert.ok(heavy.ink > light.ink, "the heavy phase must carry more ink than the light one");

  // Zpix synthesises bold at the same advance width, which is what makes this
  // blink readable rather than jittery: the glyphs must not shift sideways.
  const firstInk = (sig) => sig.indexOf("1") % (LEFT_W - 2);
  assert.equal(firstInk(heavy.sig), firstInk(light.sig), "the text must not move between phases");
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

// Row 2's date went to 1.5x on 2026-07-30 and the weekday did not, because at
// 21px the pair measures 200px against 193px of usable row and collides into
// "2026年7月30日周四". Nothing threw -- the text just ran together -- so this
// measures the widths instead of trusting them.
test("row 2's date and weekday cannot collide at any date this century", async () => {
  const { createCanvas } = await import("@napi-rs/canvas");
  const g = createCanvas(LEFT_W, 40).getContext("2d");
  const avail = DATE_ROW_RIGHT - DATE_ROW_LEFT;

  // The widest date this font can be asked for: a two-digit month and day.
  g.font = `800 ${DATE_PX}px "Zpix"`;
  const dateW = g.measureText("2026年12月30日").width;
  g.font = `800 ${WEEKDAY_PX}px "Zpix"`;
  const weekdayW = Math.max(...["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    .map((d) => g.measureText(d).width));

  assert.ok(
    dateW + weekdayW < avail,
    `date ${Math.round(dateW)} + weekday ${Math.round(weekdayW)} must fit in ${avail}`,
  );
});

test("the blink alternates on a fixed period and a still frame shows the loud phase", () => {
  const half = ENCOUNTER_BLINK_PERIOD / 2;
  for (let i = 0; i < half; i += 1) assert.equal(encounterBlinkOn(i), true, `phase ${i}`);
  for (let i = half; i < ENCOUNTER_BLINK_PERIOD; i += 1) assert.equal(encounterBlinkOn(i), false, `phase ${i}`);
  assert.equal(encounterBlinkOn(ENCOUNTER_BLINK_PERIOD), true, "it must wrap");

  // paintFromDisk and the dashboard preview render without an animator.
  assert.equal(encounterBlinkOn(undefined), true);
});
