import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveMood, applyDailyGrowth, expToNextLevel, PARAMS } from "../src/pet/sim.js";

test("deriveMood maps 5h percentage thresholds and cost spike", () => {
  assert.equal(deriveMood({ p5h: 0, todayCost: 1 }), "happy");
  assert.equal(deriveMood({ p5h: 49, todayCost: 1 }), "happy");
  assert.equal(deriveMood({ p5h: 50, todayCost: 1 }), "focused");
  assert.equal(deriveMood({ p5h: 79, todayCost: 1 }), "focused");
  assert.equal(deriveMood({ p5h: 80, todayCost: 1 }), "strained");
  assert.equal(deriveMood({ p5h: 99, todayCost: 1 }), "strained");
  assert.equal(deriveMood({ p5h: 100, todayCost: 1 }), "fainted");
  assert.equal(deriveMood({ p5h: 40, todayCost: 30 }), "shocked");
});

test("deriveMood treats unknown (null/undefined) utilization as neutral, not happy", () => {
  assert.equal(deriveMood({ p5h: null, todayCost: 0 }), "focused");
  assert.equal(deriveMood({ p5h: null, todayCost: null }), "focused");
  assert.equal(deriveMood({ p5h: undefined, todayCost: 1 }), "focused");
  assert.equal(deriveMood({ p5h: null, todayCost: 30 }), "shocked");
});

test("deriveMood treats stale rate utilization as unknown but preserves cost spike mood", () => {
  assert.equal(deriveMood({ p5h: 100, rateStale: true }), "focused");
  assert.equal(deriveMood({ p5h: 100, rateStale: false }), "fainted");
  assert.equal(deriveMood({ todayCost: 30, p5h: 100, rateStale: true }), "shocked");
});

test("applyDailyGrowth caps EXP gain and bond gain per day", () => {
  const pet = { level: 1, exp: 0, bond: 100, lastGrowthDay: "2026-06-17", todayCreditedExp: 0, todayCreditedBond: 0 };

  const out = applyDailyGrowth(pet, { todayTokens: 99_999_999, today: "2026-06-17" });

  assert.equal(out.expGain, PARAMS.dailyExpCap);
  assert.ok(out.level > pet.level, "a full day of usage must move the level");
  assert.ok(out.exp < expToNextLevel(out.level), "leftover EXP stays inside the new level's bar");
  assert.ok(out.bond <= pet.bond + PARAMS.bondPerActiveDay);
});

test("newborn does not retroactively level up from pre-birth usage on its birth day", () => {
  const newborn = { level: 1, exp: 0, bond: 0, todayCreditedExp: 0, todayCreditedBond: 0, lastGrowthDay: null };
  // Heavy usage already spent today BEFORE the pet was created:
  const out = applyDailyGrowth(newborn, { todayTokens: 99_999_999, today: "2026-06-17" });
  assert.equal(out.level, 1, "newborn must stay Lv.1 on birth day");
  assert.equal(out.expGain, 0, "birth day grants no exp from pre-birth tokens");
  assert.equal(out.lastGrowthDay, "2026-06-17");
});

test("the day AFTER birth, the pet earns exp normally", () => {
  let pet = { level: 1, exp: 0, bond: 0, todayCreditedExp: 0, todayCreditedBond: 0, lastGrowthDay: null };
  pet = applyDailyGrowth(pet, { todayTokens: 99_999_999, today: "2026-06-17" }); // birth day: anchored
  pet = applyDailyGrowth(pet, { todayTokens: 99_999_999, today: "2026-06-18" }); // next day: fresh budget
  assert.equal(pet.expGain, PARAMS.dailyExpCap);
  assert.ok(pet.level > 1, "the first full day past birth must level the pet");
});

test("applyDailyGrowth respects the daily bond soft cap", () => {
  const pet = { level: 1, exp: 0, bond: PARAMS.bondSoftCap - 1, lastGrowthDay: "2026-06-17", todayCreditedExp: 0, todayCreditedBond: 0 };

  const out = applyDailyGrowth(pet, { todayTokens: 10_000, today: "2026-06-17" });

  assert.equal(out.bond, PARAMS.bondSoftCap);
});

test("applyDailyGrowth treats future lastGrowthDay as same-day date regression", () => {
  const pet = {
    level: 2,
    exp: 1, // inside level 2's bar, so a no-gain tick must leave it exactly there
    bond: 20,
    lastGrowthDay: "2026-06-18",
    todayCreditedExp: PARAMS.dailyExpCap,
    todayCreditedBond: PARAMS.bondPerActiveDay,
  };

  const out = applyDailyGrowth(pet, { todayTokens: 99_999_999, today: "2026-06-17" });

  assert.equal(out.expGain, 0);
  assert.equal(out.level, 2);
  assert.equal(out.exp, 1);
  assert.equal(out.bond, 20);
  assert.equal(out.lastGrowthDay, "2026-06-18");
  assert.equal(out.todayCreditedExp, PARAMS.dailyExpCap);
  assert.equal(out.todayCreditedBond, PARAMS.bondPerActiveDay);
});

test("applyDailyGrowth requires an explicit local today", () => {
  assert.throws(
    () => applyDailyGrowth({ level: 1, exp: 0, bond: 0 }, { todayTokens: 1_000 }),
    /today is required/,
  );
});

test("evolveBond is the ~2-week-from-zero threshold (56)", () => {
  assert.equal(PARAMS.evolveBond, 56);
});

test("newborn bond 0 reaches evolveBond in ~14 active days at bondPerActiveDay", () => {
  let pet = { level: 1, exp: 0, bond: 0, todayCreditedExp: 0, todayCreditedBond: 0, lastGrowthDay: null };
  let days = 0;
  for (let i = 0; i < 30; i += 1) {
    const day = `2026-06-${String(10 + i).padStart(2, "0")}`;
    pet = applyDailyGrowth(pet, { todayTokens: 60_000, today: day });
    days += 1;
    if (pet.bond >= PARAMS.evolveBond) break;
  }
  assert.ok(days >= 12 && days <= 16, `expected ~14 days, got ${days}`);
});
