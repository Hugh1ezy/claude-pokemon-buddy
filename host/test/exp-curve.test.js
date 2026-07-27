import { test } from "node:test";
import assert from "node:assert/strict";

import { applyDailyGrowth, daysToNextLevel, expToNextLevel, PARAMS } from "../src/pet/sim.js";
import { renderFrame } from "../src/render/frame.js";
import { LEFT_W } from "../src/render/palette.js";

const FULL_DAY_TOKENS = 99_999_999; // more than enough to hit dailyExpCap

test("one full day of usage is worth exactly one day of EXP", () => {
  assert.equal(PARAMS.dailyExpCap, PARAMS.levelExp);
});

test("the level curve never gets cheaper and never exceeds the cap", () => {
  let previous = 0;
  for (let level = 1; level <= 60; level += 1) {
    const days = daysToNextLevel(level);
    assert.ok(Number.isInteger(days) && days >= 1, `level ${level} must cost whole days`);
    assert.ok(days >= previous, `level ${level} must not be cheaper than level ${level - 1}`);
    assert.ok(days <= PARAMS.levelDaysCap, `level ${level} must stay under the cap`);
    assert.equal(expToNextLevel(level), days * PARAMS.levelExp);
    previous = days;
  }
});

test("levelling slows down: a later level costs strictly more days than the first", () => {
  assert.equal(daysToNextLevel(1), 1, "the first level lands after a single day");
  assert.ok(daysToNextLevel(6) > daysToNextLevel(2), "the curve must actually stretch");
  assert.equal(daysToNextLevel(PARAMS.levelDaysCap * 10), PARAMS.levelDaysCap, "the tail flattens at the cap");
});

test("daysToNextLevel survives a garbage level instead of diverging", () => {
  assert.equal(daysToNextLevel(undefined), daysToNextLevel(1));
  assert.equal(daysToNextLevel(NaN), daysToNextLevel(1));
  assert.equal(daysToNextLevel(-3), daysToNextLevel(1));
});

test("a full day levels Lv.1 but is not enough for a later level", () => {
  const born = { level: 1, exp: 0, bond: 0, todayCreditedExp: 0, todayCreditedBond: 0, lastGrowthDay: "2026-06-16" };
  const afterOneDay = applyDailyGrowth(born, { todayTokens: FULL_DAY_TOKENS, today: "2026-06-17" });
  assert.equal(afterOneDay.level, 2);
  assert.equal(afterOneDay.exp, 0);

  const later = { level: 6, exp: 0, bond: 0, todayCreditedExp: 0, todayCreditedBond: 0, lastGrowthDay: "2026-06-16" };
  const laterAfterOneDay = applyDailyGrowth(later, { todayTokens: FULL_DAY_TOKENS, today: "2026-06-17" });
  assert.equal(laterAfterOneDay.level, 6, "one day must not be enough at Lv.6");
  assert.equal(laterAfterOneDay.exp, PARAMS.levelExp, "the day still banks a full day of EXP");
});

test("a carried-over EXP pool pays each level's own rising price", () => {
  // Hand the pet enough banked EXP for several levels at once: it must spend the
  // cost of level 1, then of level 2, and so on -- not N * the first level's cost.
  const banked = expToNextLevel(1) + expToNextLevel(2) + expToNextLevel(3);
  const pet = {
    level: 1,
    exp: banked - PARAMS.levelExp, // the last full day arrives via today's usage
    bond: 0,
    todayCreditedExp: 0,
    todayCreditedBond: 0,
    lastGrowthDay: "2026-06-16",
  };

  const out = applyDailyGrowth(pet, { todayTokens: FULL_DAY_TOKENS, today: "2026-06-17" });

  assert.equal(out.level, 4);
  assert.equal(out.exp, 0);
});

test("EXP stays inside the current level's bar", () => {
  let pet = { level: 1, exp: 0, bond: 0, todayCreditedExp: 0, todayCreditedBond: 0, lastGrowthDay: null };
  for (let i = 0; i < 40; i += 1) {
    const day = `2026-06-${String(10 + i).padStart(2, "0")}`;
    pet = applyDailyGrowth(pet, { todayTokens: FULL_DAY_TOKENS, today: day });
    assert.ok(pet.exp < expToNextLevel(pet.level), `day ${day}: exp ${pet.exp} overflowed level ${pet.level}`);
  }
});

// --- the bar itself -------------------------------------------------------

const BAR_X = LEFT_W + 14;
const BAR_W = 156;
const BAR_MID_Y = 39; // BUDDY_ROW2_Y (34) + 2px border + mid-height of the 7px interior

test("the EXP bar draws one cell per day the level costs", async () => {
  for (const days of [1, 3, 8]) {
    const { bitmap } = await renderFrame(baseModel({ expDaysNeeded: days, expDaysDone: days, expPct: 100 }));
    assert.equal(
      gapsInBarRow(bitmap),
      days - 1,
      `a ${days}-day level must show ${days} cells (${days - 1} dividers)`,
    );
  }
});

test("a partially earned level leaves the unearned cells hollow", async () => {
  const { bitmap } = await renderFrame(baseModel({ expDaysNeeded: 4, expDaysDone: 1, expPct: 25 }));
  const filled = inkInBarRow(bitmap);

  const { bitmap: full } = await renderFrame(baseModel({ expDaysNeeded: 4, expDaysDone: 4, expPct: 100 }));
  assert.ok(filled < inkInBarRow(full), "one earned day must paint less ink than four");
  assert.ok(filled > 0, "the earned day must still be visible");
});

test("a level too wide to draw as cells falls back to a plain bar", async () => {
  const { bitmap } = await renderFrame(baseModel({ expDaysNeeded: 999, expDaysDone: 999, expPct: 100 }));
  assert.equal(gapsInBarRow(bitmap), 0, "the fallback bar is one continuous fill, no dividers");
});

test("a model with no day info still renders the old proportional bar", async () => {
  const { bitmap } = await renderFrame(baseModel({ expPct: 100 }));
  assert.equal(gapsInBarRow(bitmap), 0);
  assert.ok(inkInBarRow(bitmap) > 0);
});

function bit(bitmap, x, y) {
  const rowBytes = Math.ceil(bitmap.w / 8);
  return (bitmap.bytes[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
}

// Unlit runs strictly inside the bar's interior == the dividers between cells.
function gapsInBarRow(bitmap) {
  let gaps = 0;
  let inGap = false;
  for (let x = BAR_X + 2; x < BAR_X + BAR_W - 2; x += 1) {
    const lit = bit(bitmap, x, BAR_MID_Y) === 1;
    if (!lit && !inGap) {
      gaps += 1;
      inGap = true;
    } else if (lit) {
      inGap = false;
    }
  }
  return gaps;
}

function inkInBarRow(bitmap) {
  let count = 0;
  for (let x = BAR_X + 2; x < BAR_X + BAR_W - 2; x += 1) count += bit(bitmap, x, BAR_MID_Y);
  return count;
}

function baseModel(buddyExtra) {
  return {
    p5h: 12,
    pweek: 34,
    todayCost: 1,
    now: new Date(2026, 5, 10, 14),
    weather: { cond: "多云", temp: 12, humidity: 50 },
    room: { t: 21, h: 45 },
    out: { t: 12, h: 50 },
    buddy: {
      spriteGray: new Uint8Array(40 * 40).fill(255),
      spriteW: 40,
      spriteH: 40,
      mood: "happy",
      level: 5,
      bond: 40,
      bubble: "Bui!",
      species: "eevee",
      readyToEvolve: false,
      ...buddyExtra,
    },
  };
}
