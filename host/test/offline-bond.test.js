import { test } from "node:test";
import assert from "node:assert/strict";

import { applyBondTick, applyOfflineBond } from "../src/pet/bond.js";
import { parseOfflineBond } from "../src/transport/framing.js";
import { applyRecordedOfflineBonds, epochDayFor } from "../src/index.js";

// 2026-07-27 is a Monday: a working day, window open 09:00-18:59.
const MON = (h, m = 0) => new Date(2026, 6, 27, h, m);
const SAT = (h, m = 0) => new Date(2026, 7, 1, h, m);
const MON_YMD = "2026-07-27";
const SAT_YMD = "2026-08-01";
const MON_DAY = epochDayFor(MON(12));

function pet(extra = {}) {
  return { level: 5, exp: 0, bond: 0, bondDay: null, bondHalves: 0, bondSlots: 0, ...extra };
}

function frame(epochDay, hours) {
  const mask = hours.reduce((acc, h) => acc | (1 << h), 0);
  return Uint8Array.from([
    epochDay & 0xff, (epochDay >> 8) & 0xff,
    mask & 0xff, (mask >> 8) & 0xff, (mask >> 16) & 0xff,
  ]);
}

test("the wire format round-trips a day and its hours", () => {
  const parsed = parseOfflineBond(frame(MON_DAY, [9, 13, 23]));
  assert.deepEqual(parsed, { epochDay: MON_DAY, hours: [9, 13, 23] });
});

test("a short payload is rejected rather than read as hour zero", () => {
  assert.equal(parseOfflineBond(Uint8Array.from([1, 2, 3, 4])), null);
});

test("recorded hours pay out half a heart each on a working day", () => {
  const before = pet();
  const after = applyOfflineBond(before, {
    offline: { epochDay: MON_DAY, hours: [9, 10, 11] },
    now: MON(12),
    today: MON_YMD,
    epochDay: MON_DAY,
  });

  assert.equal(after.bondHalves, 3);
  assert.ok(after.bond > before.bond, "cumulative bond must move too");
});

// This is the property the whole design rests on: the device keeps republishing
// the same mask all day precisely because replaying it is free, which is what
// removes the need for an acknowledgement or a delete-after-upload step.
test("replaying the same mask credits nothing the second time", () => {
  const args = {
    offline: { epochDay: MON_DAY, hours: [9, 10] },
    now: MON(12),
    today: MON_YMD,
    epochDay: MON_DAY,
  };
  const once = applyOfflineBond(pet(), args);
  const twice = applyOfflineBond(once, args);

  assert.equal(once.bondHalves, 2);
  assert.deepEqual(twice, once);
});

test("an hour already credited live is not credited again from the device", () => {
  // The owner pressed KEY at 09:30 with the host up; the device also recorded
  // hour 9 because one of the two links was down at that moment.
  const live = applyBondTick(pet(), { now: MON(9, 30), today: MON_YMD, clicked: true });
  assert.equal(live.bondHalves, 1);

  const after = applyOfflineBond(live, {
    offline: { epochDay: MON_DAY, hours: [9] },
    now: MON(12),
    today: MON_YMD,
    epochDay: MON_DAY,
  });
  assert.equal(after.bondHalves, 1);
});

test("hours outside the day's window earn nothing", () => {
  const after = applyOfflineBond(pet(), {
    offline: { epochDay: MON_DAY, hours: [6, 7, 8, 19, 20] },
    now: MON(21),
    today: MON_YMD,
    epochDay: MON_DAY,
  });
  assert.equal(after.bondHalves, 0);
});

test("another day's mask is dropped, not applied to today", () => {
  const after = applyOfflineBond(pet(), {
    offline: { epochDay: MON_DAY - 1, hours: [9, 10, 11] },
    now: MON(12),
    today: MON_YMD,
    epochDay: MON_DAY,
  });
  assert.equal(after.bondHalves, 0);
});

// Clocks can disagree by a minute either way; crediting an hour that has not
// arrived yet is the wrong way to be wrong, since it comes round on its own.
test("an hour in the future is skipped", () => {
  const after = applyOfflineBond(pet(), {
    offline: { epochDay: MON_DAY, hours: [9, 15] },
    now: MON(10),
    today: MON_YMD,
    epochDay: MON_DAY,
  });
  assert.equal(after.bondHalves, 1);
});

// The weekend pays out on its own, so an offline press must not be able to buy
// a second half heart for an hour the auto rule already covered.
test("a weekend hour cannot be paid twice", () => {
  const satDay = epochDayFor(SAT(12));
  const auto = applyBondTick(pet(), { now: SAT(9, 5), today: SAT_YMD, clicked: false });
  assert.equal(auto.bondHalves, 1);

  const after = applyOfflineBond(auto, {
    offline: { epochDay: satDay, hours: [9] },
    now: SAT(12),
    today: SAT_YMD,
    epochDay: satDay,
  });
  assert.equal(after.bondHalves, 1);
});

test("the tick drains the queue so a later tick does not reapply it", () => {
  const queue = [{ epochDay: MON_DAY, hours: [9, 10] }];
  const logged = [];
  const logger = { log: (line) => logged.push(line) };

  const after = applyRecordedOfflineBonds(pet(), queue, { now: MON(12), today: MON_YMD }, logger);
  assert.equal(after.bondHalves, 2);
  assert.equal(queue.length, 0, "the queue must be drained");
  assert.equal(logged.length, 1);

  const again = applyRecordedOfflineBonds(after, queue, { now: MON(12), today: MON_YMD }, logger);
  assert.deepEqual(again, after);
  assert.equal(logged.length, 1, "a tick that credits nothing must stay quiet");
});
