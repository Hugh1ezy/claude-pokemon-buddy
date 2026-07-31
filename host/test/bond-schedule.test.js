import { test } from "node:test";
import assert from "node:assert/strict";

import { applyBondTick, bondSlotAt, settleBondExp, heartsFromHalves, MAX_HEARTS, SLOTS_PER_DAY } from "../src/pet/bond.js";
import { expToNextLevel, PARAMS } from "../src/pet/sim.js";

const MON = (h, m = 0) => new Date(2026, 6, 27, h, m); // 2026-07-27 is a Monday
const THU = (h, m = 0) => new Date(2026, 6, 30, h, m);
const SAT = (h, m = 0) => new Date(2026, 7, 1, h, m);
const YMD = { mon: "2026-07-27", thu: "2026-07-30", sat: "2026-08-01" };

function pet(extra = {}) {
  return { level: 5, exp: 0, bond: 0, bondDay: null, bondHalves: 0, bondSlots: 0, ...extra };
}

test("the working-day window opens at 9 and runs ten hourly slots", () => {
  assert.equal(bondSlotAt(MON(8, 59)), null);
  assert.equal(bondSlotAt(MON(9, 0)), 0);
  assert.equal(bondSlotAt(MON(9, 59)), 0);
  assert.equal(bondSlotAt(MON(10, 0)), 1);
  assert.equal(bondSlotAt(MON(18, 59)), SLOTS_PER_DAY - 1);
  assert.equal(bondSlotAt(MON(19, 0)), null);
});

test("Thursday's window is shifted later, same ten slots", () => {
  assert.equal(bondSlotAt(THU(10, 59)), null);
  assert.equal(bondSlotAt(THU(11, 0)), 0);
  assert.equal(bondSlotAt(THU(20, 59)), SLOTS_PER_DAY - 1);
  assert.equal(bondSlotAt(THU(21, 0)), null);
});

test("a working-day slot pays only when KEY was pressed inside it", () => {
  const idle = applyBondTick(pet(), { now: MON(9, 30), today: YMD.mon, clicked: false });
  assert.equal(idle.bondHalves, 0, "no press, no half heart");

  const pressed = applyBondTick(pet(), { now: MON(9, 30), today: YMD.mon, clicked: true });
  assert.equal(pressed.bondHalves, 1);
});

test("a slot pays at most once no matter how often KEY is pressed", () => {
  let p = applyBondTick(pet(), { now: MON(9, 5), today: YMD.mon, clicked: true });
  p = applyBondTick(p, { now: MON(9, 25), today: YMD.mon, clicked: true });
  p = applyBondTick(p, { now: MON(9, 55), today: YMD.mon, clicked: true });
  assert.equal(p.bondHalves, 1);

  p = applyBondTick(p, { now: MON(10, 5), today: YMD.mon, clicked: true });
  assert.equal(p.bondHalves, 2, "the next hour is a fresh slot");
});

test("a skipped hour is simply lost -- the next one starts clean", () => {
  let p = applyBondTick(pet(), { now: MON(9, 30), today: YMD.mon, clicked: true });
  p = applyBondTick(p, { now: MON(10, 30), today: YMD.mon, clicked: false }); // skipped
  p = applyBondTick(p, { now: MON(11, 30), today: YMD.mon, clicked: true });

  assert.equal(p.bondHalves, 2, "the skipped hour costs its own half heart and nothing more");
});

test("outside the window KEY earns nothing", () => {
  const p = applyBondTick(pet(), { now: MON(22, 0), today: YMD.mon, clicked: true });
  assert.equal(p.bondHalves, 0);
});

test("weekends pay hourly on their own and KEY cannot buy extra", () => {
  let p = applyBondTick(pet(), { now: SAT(9, 30), today: YMD.sat, clicked: false });
  assert.equal(p.bondHalves, 1, "no press needed at the weekend");

  p = applyBondTick(p, { now: SAT(9, 45), today: YMD.sat, clicked: true });
  assert.equal(p.bondHalves, 1, "pressing again in the same hour adds nothing");
});

test("a full attendance day is exactly five hearts", () => {
  let p = pet();
  for (let hour = 9; hour < 19; hour += 1) {
    p = applyBondTick(p, { now: MON(hour, 30), today: YMD.mon, clicked: true });
  }
  assert.equal(p.bondHalves, SLOTS_PER_DAY);
  assert.equal(heartsFromHalves(p.bondHalves), MAX_HEARTS);
});

test("hearts reset with the day", () => {
  const yesterday = applyBondTick(pet(), { now: MON(9, 30), today: YMD.mon, clicked: true });
  const today = applyBondTick(yesterday, { now: THU(11, 30), today: YMD.thu, clicked: false });

  assert.equal(today.bondHalves, 0, "a new day starts at zero hearts");
  assert.equal(today.bondSlots, 0);
  assert.equal(today.bondDay, YMD.thu);
});

// The rate is unchanged; WHEN it lands is what moved on 2026-07-31. A half
// heart is owed as it is earned and paid when the day's window shuts or the
// pokemon leaves the panel -- see settleBondExp.
test("each half heart is owed half a percent of the level's bar", () => {
  const level = 5;
  const bar = expToNextLevel(level);
  const p = applyBondTick(pet({ level }), { now: MON(9, 30), today: YMD.mon, clicked: true });

  assert.equal(p.exp, 0, "nothing is paid while the window is still open");
  assert.equal(p.bondUnpaid, 1);

  const paid = settleBondExp(p);
  assert.ok(Math.abs(paid.exp - bar * 0.005) < 1e-9, `expected 0.5% of ${bar}, got ${paid.exp}`);
  assert.equal(paid.bondUnpaid, 0);
});

// Settling twice must not pay twice -- this is the property that replaced the
// short-lived "cash in on swap" step, which paid on top of an already-granted
// amount.
test("settling again pays nothing", () => {
  const p = applyBondTick(pet({ level: 5 }), { now: MON(9, 30), today: YMD.mon, clicked: true });
  const once = settleBondExp(p);
  assert.deepEqual(settleBondExp(once), once);
});

test("a full five-heart day hands over 5% of the level", () => {
  const level = 5;
  const bar = expToNextLevel(level);
  let p = pet({ level });
  for (let hour = 9; hour < 19; hour += 1) {
    p = applyBondTick(p, { now: MON(hour, 30), today: YMD.mon, clicked: true });
  }
  // 19:00 closes the window, and the tick that lands after it settles the day.
  const closed = applyBondTick(p, { now: MON(19, 5), today: YMD.mon, clicked: false });

  assert.equal(closed.level, level, "5% of a bar must not be enough to level on its own");
  assert.ok(Math.abs(closed.exp - bar * 0.05) < 1e-9, `expected 5% of ${bar}, got ${closed.exp}`);
  assert.equal(closed.bondHalves, 10, "the hearts stay on the panel after settling");
  assert.equal(closed.bondUnpaid, 0);
});

test("bond EXP can still tip a nearly-full bar over into the next level", () => {
  const level = 5;
  const bar = expToNextLevel(level);
  // 0.4% short of the next level -- one half heart (0.5%) covers the gap.
  const p = applyBondTick(pet({ level, exp: bar * 0.996 }), { now: MON(9, 30), today: YMD.mon, clicked: true });
  assert.equal(settleBondExp(p).level, level + 1);
});

test("lifetime bond keeps its old pace so friendship evolutions still take ~2 weeks", () => {
  let p = pet();
  let days = 0;
  while (p.bond < PARAMS.evolveBond && days < 60) {
    days += 1;
    p = { ...p, bondDay: null, bondHalves: 0, bondSlots: 0 };
    for (let hour = 9; hour < 19; hour += 1) {
      p = applyBondTick(p, { now: MON(hour, 30), today: `2026-06-${String(days).padStart(2, "0")}`, clicked: true });
    }
  }
  assert.ok(days >= 12 && days <= 16, `expected ~14 full days, got ${days}`);
});

test("applyBondTick refuses to guess the clock or the calendar day", () => {
  assert.throws(() => applyBondTick(pet(), { today: YMD.mon }), /now is required/);
  assert.throws(() => applyBondTick(pet(), { now: MON(9, 30) }), /today is required/);
});
