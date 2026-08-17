import { test } from "node:test";
import assert from "node:assert/strict";
import {
  settleDays,
  settlementWindow,
  activeDaysFromUsage,
  buildUsedDays,
  careDaySet,
  isCareDay,
  normalizeCareDays,
  daysTogether,
  recordCareDay,
  recordTogetherSince,
  togetherSinceOf,
  MAX_CARE_DAYS,
} from "../src/pet/settlement.js";

test("settles each missed day once and rerun for same today is idempotent", () => {
  const pet = { bond: 100, lastSettled: "2026-05-25", streak: 5, shield: 1 };

  const a = settleDays(pet, "2026-05-28", { usedDays: new Set() });
  const b = settleDays(a, "2026-05-28", { usedDays: new Set() });

  assert.deepEqual(b, a);
  assert.equal(a.lastSettled, "2026-05-27");
  assert.equal(a.shield, 0);
  assert.equal(a.streak, 0);
  assert.equal(a.bond, 97);
});

test("does not settle the current day before it is complete", () => {
  const pet = { bond: 100, lastSettled: "2026-05-29", streak: 5, shield: 0 };

  const out = settleDays(pet, "2026-05-30", { usedDays: new Set() });

  assert.deepEqual(out, pet);
});

test("settles only completed days in order", () => {
  const pet = { bond: 100, lastSettled: "2026-05-25", streak: 5, shield: 0 };
  const usedDays = new Set(["2026-05-26", "2026-05-28"]);

  const out = settleDays(pet, "2026-05-28", { usedDays });

  assert.equal(out.bond, 97);
  assert.equal(out.streak, 0);
  assert.equal(out.lastSettled, "2026-05-27");
});

test("shield is consumed before breaking streak or decaying bond", () => {
  const pet = { bond: 100, lastSettled: "2026-05-25", streak: 5, shield: 1 };

  const out = settleDays(pet, "2026-05-27", { usedDays: new Set() });

  assert.equal(out.shield, 0);
  assert.equal(out.streak, 5);
  assert.equal(out.bond, 100);
});

test("care count decays by one for each completed daily settlement and never goes negative", () => {
  const oneCare = settleDays(
    { bond: 100, lastSettled: "2026-05-25", streak: 0, shield: 0, careCount: 1 },
    "2026-05-27",
    { usedDays: new Set(["2026-05-26"]) },
  );
  const noCare = settleDays(
    { bond: 100, lastSettled: "2026-05-25", streak: 0, shield: 0, careCount: 0 },
    "2026-05-27",
    { usedDays: new Set(["2026-05-26"]) },
  );

  assert.equal(oneCare.careCount, 0);
  assert.equal(noCare.careCount, 0);
});

test("active streak crossing 7-day multiples grants shields capped at two", () => {
  const firstShield = settleDays(
    { bond: 100, lastSettled: "2026-05-25", streak: 6, shield: 0 },
    "2026-05-27",
    { usedDays: new Set(["2026-05-26"]) },
  );
  const secondShield = settleDays(
    { bond: 100, lastSettled: "2026-05-25", streak: 13, shield: 1 },
    "2026-05-27",
    { usedDays: new Set(["2026-05-26"]) },
  );
  const capped = settleDays(
    { bond: 100, lastSettled: "2026-05-25", streak: 20, shield: 2 },
    "2026-05-27",
    { usedDays: new Set(["2026-05-26"]) },
  );

  assert.equal(firstShield.streak, 7);
  assert.equal(firstShield.shield, 1);
  assert.equal(secondShield.streak, 14);
  assert.equal(secondShield.shield, 2);
  assert.equal(capped.streak, 21);
  assert.equal(capped.shield, 2);
});

test("caps catch-up at maxCatchupDays", () => {
  const pet = { bond: 200, lastSettled: "2026-01-01", streak: 0, shield: 0 };

  const out = settleDays(pet, "2026-01-06", {
    usedDays: new Set(),
    maxCatchupDays: 2,
  });

  assert.equal(out.bond, 194);
  assert.equal(out.lastSettled, "2026-01-05");
});

test("settlementWindow lists capped, exclusive days between lastSettled and today", () => {
  assert.deepEqual(settlementWindow("2026-05-27", "2026-05-31"), [
    "2026-05-28",
    "2026-05-29",
    "2026-05-30",
  ]);
  assert.deepEqual(settlementWindow("2026-05-30", "2026-05-31"), []);
  assert.deepEqual(settlementWindow(null, "2026-05-31"), []);
});

test("settlementWindow only materializes the trailing catch-up window for ancient dates", () => {
  const RealDate = Date;
  let constructed = 0;
  globalThis.Date = class CountingDate extends RealDate {
    constructor(...args) {
      constructed += 1;
      if (constructed > 40) throw new Error("settlementWindow constructed too many dates");
      super(...args);
    }

    static now() {
      return RealDate.now();
    }

    static parse(value) {
      return RealDate.parse(value);
    }

    static UTC(...args) {
      return RealDate.UTC(...args);
    }
  };

  try {
    const days = settlementWindow("0001-01-01", "2026-07-05", 30);
    assert.equal(days.length, 30);
    assert.ok(constructed <= 40);
  } finally {
    globalThis.Date = RealDate;
  }
});

test("activeDaysFromUsage returns null when history is unavailable", () => {
  assert.equal(activeDaysFromUsage(undefined), null);
  assert.equal(activeDaysFromUsage({ ok: false }), null);
  assert.equal(activeDaysFromUsage({ ok: true }), null);
  assert.equal(activeDaysFromUsage({ ok: true, activeDays: [] }), null);
});

test("buildUsedDays marks ccusage-active window days as used", () => {
  const pet = { lastSettled: "2026-05-27", lastGrowthDay: null };
  const usage = {
    ok: true,
    activeDays: ["2026-05-26", "2026-05-27", "2026-05-28", "2026-05-29", "2026-05-30"],
  };
  const used = buildUsedDays(pet, "2026-05-31", usage);
  assert.deepEqual([...used].sort(), ["2026-05-28", "2026-05-29", "2026-05-30"]);
});

test("buildUsedDays decays genuine inactive days within ccusage's known range", () => {
  const pet = { lastSettled: "2026-05-27", lastGrowthDay: null };
  const usage = { ok: true, activeDays: ["2026-05-27", "2026-05-28", "2026-05-30"] };
  const used = buildUsedDays(pet, "2026-05-31", usage);
  // 2026-05-29 absent within known range -> NOT used (will decay)
  assert.equal(used.has("2026-05-28"), true);
  assert.equal(used.has("2026-05-29"), false);
  assert.equal(used.has("2026-05-30"), true);
});

test("buildUsedDays fails open for days before ccusage's earliest record", () => {
  const pet = { lastSettled: "2026-05-27", lastGrowthDay: null };
  const usage = { ok: true, activeDays: ["2026-05-30"] }; // earliest known = 05-30
  const used = buildUsedDays(pet, "2026-05-31", usage);
  // 05-28, 05-29 predate ccusage knowledge -> fail-open (used); 05-30 active (used)
  assert.deepEqual([...used].sort(), ["2026-05-28", "2026-05-29", "2026-05-30"]);
});

test("buildUsedDays fails open entirely when usage history is unavailable", () => {
  const pet = { lastSettled: "2026-05-27", lastGrowthDay: null };
  const used = buildUsedDays(pet, "2026-05-31", { ok: false });
  assert.deepEqual([...used].sort(), ["2026-05-28", "2026-05-29", "2026-05-30"]);
});

test("buildUsedDays counts the in-progress last growth day when it earned", () => {
  const pet = {
    lastSettled: "2026-05-29",
    lastGrowthDay: "2026-05-30",
    todayCreditedExp: 4,
    todayCreditedBond: 4,
  };
  const used = buildUsedDays(pet, "2026-05-31", { ok: false });
  assert.equal(used.has("2026-05-30"), true);
});

// --- care days -------------------------------------------------------------
// The regression these pin is 2026-08-13: a day with 15 KEY presses and no
// tokens on this machine, settled as missed, which zeroed a 17-day streak.

test("a day the buddy was petted survives a settlement that ccusage calls empty", () => {
  const pet = {
    bond: 100,
    streak: 17,
    shield: 0,
    lastSettled: "2026-08-12",
    careDays: ["2026-08-13"],
  };
  const usage = { ok: true, activeDays: ["2026-08-11", "2026-08-14"] };

  const out = settleDays(pet, "2026-08-14", { usedDays: buildUsedDays(pet, "2026-08-14", usage) });

  assert.equal(out.streak, 18);
  assert.equal(out.bond, 100);
});

test("a day with no care record and no usage still decays", () => {
  const pet = { bond: 100, streak: 17, shield: 0, lastSettled: "2026-08-12", careDays: ["2026-08-11"] };
  const usage = { ok: true, activeDays: ["2026-08-11", "2026-08-14"] };

  const out = settleDays(pet, "2026-08-14", { usedDays: buildUsedDays(pet, "2026-08-14", usage) });

  assert.equal(out.streak, 0);
  assert.equal(out.bond, 97);
});

test("isCareDay accepts a paid bond slot, today's token credit, and nothing else", () => {
  assert.equal(isCareDay({ bondDay: "2026-08-13", bondHalves: 1 }, "2026-08-13"), true);
  assert.equal(isCareDay({ bondDay: "2026-08-13", bondUnpaid: 2 }, "2026-08-13"), true);
  assert.equal(isCareDay({ bondDay: "2026-08-13", bondSlots: 16 }, "2026-08-13"), true);
  assert.equal(isCareDay({ lastGrowthDay: "2026-08-13", todayCreditedExp: 40 }, "2026-08-13"), true);
  assert.equal(isCareDay({ lastGrowthDay: "2026-08-13", todayCreditedBond: 4 }, "2026-08-13"), true);
  // Yesterday's counters say nothing about today.
  assert.equal(isCareDay({ bondDay: "2026-08-12", bondHalves: 4 }, "2026-08-13"), false);
  assert.equal(isCareDay({ bondDay: "2026-08-13", bondHalves: 0 }, "2026-08-13"), false);
  assert.equal(isCareDay({}, "2026-08-13"), false);
  assert.equal(isCareDay({ bondDay: "nonsense", bondHalves: 4 }, "nonsense"), false);
});

test("recordCareDay returns the same object when there is nothing to add", () => {
  const idle = { bondDay: "2026-08-13", bondHalves: 0 };
  assert.equal(recordCareDay(idle, "2026-08-13"), idle);

  const already = { bondDay: "2026-08-13", bondHalves: 2, careDays: ["2026-08-13"] };
  assert.equal(recordCareDay(already, "2026-08-13"), already);
});

test("recordCareDay appends today and keeps the list sorted, unique and bounded", () => {
  const out = recordCareDay(
    { bondDay: "2026-08-13", bondHalves: 2, careDays: ["2026-08-12", "2026-08-12"] },
    "2026-08-13",
  );
  assert.deepEqual(out.careDays, ["2026-08-12", "2026-08-13"]);

  const long = Array.from({ length: MAX_CARE_DAYS + 10 }, (_, i) => {
    const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000);
    return day.toISOString().slice(0, 10);
  });
  const trimmed = recordCareDay(
    { bondDay: "2026-08-13", bondHalves: 2, careDays: long },
    "2026-08-13",
  );
  assert.equal(trimmed.careDays.length, MAX_CARE_DAYS);
  assert.equal(trimmed.careDays.at(-1), "2026-08-13");
});

test("normalizeCareDays drops anything that is not a plain YYYY-MM-DD", () => {
  assert.deepEqual(normalizeCareDays(["2026-08-13", 7, null, "yesterday", "2026-8-1"]), [
    "2026-08-13",
  ]);
  assert.deepEqual(normalizeCareDays("2026-08-13"), []);
  assert.deepEqual(normalizeCareDays(undefined), []);
  assert.deepEqual([...careDaySet({ careDays: ["2026-08-13", "2026-08-13"] })], ["2026-08-13"]);
});

// 「N天」 -- days together. The regression these pin is 2026-08-17: a weekend
// with both PCs powered off settled as two missed days and took 19 天 to 0.
test("days together counts calendar days and a powered-down weekend costs none", () => {
  const pet = { togetherSince: "2026-07-27", lastSettled: "2026-08-14", streak: 19, shield: 1 };

  assert.equal(daysTogether(pet, "2026-08-14"), 19);
  assert.equal(daysTogether(pet, "2026-08-17"), 22);

  // The settlement still runs and still eats the shield and the bond -- care is
  // a different question from being together -- but it cannot touch the count.
  const settled = settleDays(pet, "2026-08-17", { usedDays: new Set(), bond: 42 });
  assert.equal(settled.streak, 0);
  assert.equal(daysTogether(settled, "2026-08-17"), 22);
});

test("days together is inclusive of the day they met and never negative", () => {
  const pet = { togetherSince: "2026-07-27" };
  assert.equal(daysTogether(pet, "2026-07-27"), 1);
  assert.equal(daysTogether(pet, "2026-07-28"), 2);
  // A save carried backwards in time (clock skew, a restored machine) reads 0
  // rather than a negative number on the panel.
  assert.equal(daysTogether(pet, "2026-07-26"), 0);
});

test("an anchorless save keeps the number it was already showing", () => {
  // streak counts THROUGH lastSettled and is inclusive, so 19 天 through 08-14
  // is an anchor of 07-27 -- the same number, not a restart at 1.
  const pet = { lastSettled: "2026-08-14", streak: 19 };
  assert.equal(togetherSinceOf(pet, "2026-08-17"), "2026-07-27");
  assert.equal(daysTogether(pet, "2026-08-14"), 19);

  // Nothing to derive from -> today, i.e. day 1.
  assert.equal(togetherSinceOf({ streak: 0 }, "2026-08-17"), "2026-08-17");
  assert.equal(daysTogether({ streak: 0 }, "2026-08-17"), 1);
});

test("the anchor is written once and an anchored save round-trips identically", () => {
  const pet = { lastSettled: "2026-08-14", streak: 19 };
  const anchored = recordTogetherSince(pet, "2026-08-17");
  assert.equal(anchored.togetherSince, "2026-07-27");

  // Same object back when there is nothing to add, so save-sync sees no change.
  assert.equal(recordTogetherSince(anchored, "2026-08-18"), anchored);
});
