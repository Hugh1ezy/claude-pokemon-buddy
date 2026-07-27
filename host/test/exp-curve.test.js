import { test } from "node:test";
import assert from "node:assert/strict";

import { applyDailyGrowth, expToNextLevel, gainExp, PARAMS } from "../src/pet/sim.js";
import { eligibleBranches } from "../src/pet/evolution.js";
import { renderFrame } from "../src/render/frame.js";
import { row1Geometry } from "../src/render/layout.js";
import { LEFT_W, W } from "../src/render/palette.js";

const FULL_DAY_TOKENS = 99_999_999; // more than enough to hit dailyExpCap

test("one full day of usage is worth exactly one day of EXP", () => {
  assert.equal(PARAMS.dailyExpCap, PARAMS.levelExp);
});

test("the curve never gets cheaper as levels go up", () => {
  let previous = 0;
  for (let level = 1; level < PARAMS.maxLevel; level += 1) {
    const cost = expToNextLevel(level);
    assert.ok(Number.isInteger(cost) && cost >= 1, `level ${level} must cost whole EXP`);
    assert.ok(cost >= previous, `level ${level} must not be cheaper than level ${level - 1}`);
    previous = cost;
  }
  assert.ok(expToNextLevel(PARAMS.maxLevel - 1) > expToNextLevel(1) * 3, "the late game must cost meaningfully more");
});

test("expToNextLevel survives a garbage level instead of diverging", () => {
  assert.equal(expToNextLevel(undefined), expToNextLevel(1));
  assert.equal(expToNextLevel(NaN), expToNextLevel(1));
  assert.equal(expToNextLevel(-3), expToNextLevel(1));
  assert.equal(expToNextLevel(9999), expToNextLevel(PARAMS.maxLevel));
});

// Pace: full daily usage every day should max the buddy out in roughly a month --
// slow enough to be worth waiting for, fast enough to finish.
test("daily full usage reaches the level cap in about a month", () => {
  let pet = { level: 1, exp: 0, bond: 0, todayCreditedExp: 0, todayCreditedBond: 0, lastGrowthDay: "2026-06-09" };
  let days = 0;
  while (pet.level < PARAMS.maxLevel && days < 200) {
    days += 1;
    pet = applyDailyGrowth(pet, { todayTokens: FULL_DAY_TOKENS, today: dayString(days) });
  }
  assert.ok(days >= 25 && days <= 40, `expected roughly a month of daily use, got ${days} days`);
});

test("the level 16 / 32 evolution gates land in the first days, not the first hour", () => {
  const reached = {};
  let pet = { level: 1, exp: 0, bond: 0, todayCreditedExp: 0, todayCreditedBond: 0, lastGrowthDay: "2026-06-09" };
  for (let day = 1; day <= 20 && pet.level < 40; day += 1) {
    pet = applyDailyGrowth(pet, { todayTokens: FULL_DAY_TOKENS, today: dayString(day) });
    for (const gate of [16, 32]) {
      if (reached[gate] == null && pet.level >= gate) reached[gate] = day;
    }
  }
  assert.ok(reached[16] >= 2 && reached[16] <= 5, `Lv.16 should take a few days, took ${reached[16]}`);
  assert.ok(reached[32] > reached[16] && reached[32] <= 12, `Lv.32 should follow later, took ${reached[32]}`);
});

test("the seed tables gate evolution on the official Pokémon levels", () => {
  const gateOf = (species, at) => eligibleBranches(species, { level: at }).length;
  assert.equal(gateOf("bulbasaur", 15), 0);
  assert.equal(gateOf("bulbasaur", 16), 1);
  assert.equal(gateOf("ivysaur", 31), 0);
  assert.equal(gateOf("ivysaur", 32), 1);
  assert.equal(gateOf("charmeleon", 35), 0);
  assert.equal(gateOf("charmeleon", 36), 1);
  assert.equal(gateOf("wartortle", 35), 0);
  assert.equal(gateOf("wartortle", 36), 1);
});

test("a carried-over EXP pool pays each level's own rising price", () => {
  const banked = expToNextLevel(1) + expToNextLevel(2) + expToNextLevel(3);
  const out = gainExp(1, 0, banked);
  assert.equal(out.level, 4);
  assert.equal(out.exp, 0);
});

test("EXP stays inside the current level's bar", () => {
  let pet = { level: 1, exp: 0, bond: 0, todayCreditedExp: 0, todayCreditedBond: 0, lastGrowthDay: null };
  for (let day = 1; day <= 40; day += 1) {
    pet = applyDailyGrowth(pet, { todayTokens: FULL_DAY_TOKENS, today: dayString(day) });
    assert.ok(pet.exp <= expToNextLevel(pet.level), `day ${day}: exp ${pet.exp} overflowed level ${pet.level}`);
  }
});

test("the level cap holds and parks the bar at full", () => {
  const out = gainExp(PARAMS.maxLevel, 0, 999_999);
  assert.equal(out.level, PARAMS.maxLevel);
  assert.equal(out.exp, expToNextLevel(PARAMS.maxLevel));

  const almost = gainExp(PARAMS.maxLevel - 1, 0, 999_999);
  assert.equal(almost.level, PARAMS.maxLevel);
});

// --- the bar itself -------------------------------------------------------

const GEO = row1Geometry(LEFT_W, W - LEFT_W, 5, 0);
const BAR_MID_Y = GEO.barY + 2 + Math.floor((GEO.barH - 4) / 2);

test("the EXP bar is one continuous black fill, no dividers", async () => {
  const { bitmap } = await renderFrame(baseModel({ expPct: 100 }));
  assert.equal(gapsInBarRow(bitmap), 0);
  assert.equal(inkInBarRow(bitmap), GEO.barW - 4, "a full bar inks its whole interior");
});

test("the fill grows from the left with the percentage", async () => {
  const quarter = inkInBarRow((await renderFrame(baseModel({ expPct: 25 }))).bitmap);
  const half = inkInBarRow((await renderFrame(baseModel({ expPct: 50 }))).bitmap);
  const empty = inkInBarRow((await renderFrame(baseModel({ expPct: 0 }))).bitmap);

  assert.equal(empty, 0);
  assert.ok(quarter > 0 && quarter < half, `expected 25% (${quarter}) to be under 50% (${half})`);
  assert.ok(firstInkX((await renderFrame(baseModel({ expPct: 25 }))).bitmap) <= GEO.barX + 3, "fill starts at the left edge");
});

function dayString(index) {
  const date = new Date(2026, 5, 10);
  date.setDate(date.getDate() + index);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function bit(bitmap, x, y) {
  const rowBytes = Math.ceil(bitmap.w / 8);
  return (bitmap.bytes[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
}

function gapsInBarRow(bitmap) {
  let gaps = 0;
  let inGap = false;
  let seenInk = false;
  for (let x = GEO.barX + 2; x < GEO.barX + GEO.barW - 2; x += 1) {
    const lit = bit(bitmap, x, BAR_MID_Y) === 1;
    if (lit) {
      seenInk = true;
      inGap = false;
    } else if (seenInk && !inGap) {
      gaps += 1;
      inGap = true;
    }
  }
  // A partly filled bar ends in one trailing unlit run; that is the empty tail,
  // not a divider, so only interior gaps that are followed by more ink count.
  return Math.max(0, gaps - (trailingUnlit(bitmap) ? 1 : 0));
}

function trailingUnlit(bitmap) {
  return bit(bitmap, GEO.barX + GEO.barW - 3, BAR_MID_Y) === 0;
}

function inkInBarRow(bitmap) {
  let count = 0;
  for (let x = GEO.barX + 2; x < GEO.barX + GEO.barW - 2; x += 1) count += bit(bitmap, x, BAR_MID_Y);
  return count;
}

function firstInkX(bitmap) {
  for (let x = GEO.barX + 2; x < GEO.barX + GEO.barW - 2; x += 1) {
    if (bit(bitmap, x, BAR_MID_Y) === 1) return x;
  }
  return Infinity;
}

function baseModel(buddyExtra) {
  return {
    p5h: 12,
    pweek: 34,
    todayCost: 1,
    streak: 0,
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
