import { expToNextLevel, gainExp, PARAMS } from "./sim.js";

// 亲密度 is earned in hourly slots inside one window per day, half a heart each,
// ten slots to a full five hearts.
//
// On a working day the slot only pays out if the owner pressed KEY at least once
// while it was open -- the device is asking to be checked on, not just left
// running. A skipped hour is simply lost; the next one starts clean, there is no
// penalty beyond the missed half heart.
//
// Weekends pay out on their own and ignore KEY entirely: the buddy keeps its own
// company on days off, and pressing the button cannot buy extra credit.
export const SLOTS_PER_DAY = 10;
export const HALVES_PER_HEART = 2;
export const MAX_HEARTS = SLOTS_PER_DAY / HALVES_PER_HEART;

// getDay(): 0=Sun .. 6=Sat. Thursday starts late; the weekend is automatic.
const WINDOWS = {
  0: { startHour: 9, auto: true },   // Sun
  1: { startHour: 9, auto: false },  // Mon
  2: { startHour: 9, auto: false },  // Tue
  3: { startHour: 9, auto: false },  // Wed
  4: { startHour: 11, auto: false }, // Thu
  5: { startHour: 9, auto: false },  // Fri
  6: { startHour: 9, auto: true },   // Sat
};

export function bondWindow(date) {
  return WINDOWS[date.getDay()];
}

// True once the day's ten slots are behind us -- 19:00 on an ordinary day,
// 21:00 on a Thursday. bondSlotAt() returns null both before the window opens
// and after it shuts, so "closed" needs asking separately.
export function bondWindowClosed(date) {
  const { startHour } = bondWindow(date);
  return date.getHours() + date.getMinutes() / 60 >= startHour + SLOTS_PER_DAY;
}

// Turns whatever hearts are owed into exp, once. Half a heart is worth half a
// percent of the level in progress, so a full ten-half day is 5% of the bar.
//
// Owner's rule, 2026-07-31: the exp is NOT granted as each half is earned. It
// is settled when the day's window shuts, or when the pokemon leaves the panel,
// whichever comes first -- and it is paid exactly once either way, which is why
// `bondUnpaid` is zeroed here rather than being derived from bondHalves.
// Settling also empties the hearts on the panel (owner, 2026-07-31). They are a
// running total of what has not been paid out yet, not a record of the day, so
// once the day is settled there is nothing for them to show. `bondSlots` is the
// one that keeps the day honest -- it still says which hours have been
// collected, so emptying the hearts cannot buy a second helping.
export function settleBondExp(pet) {
  const unpaid = Math.max(0, Number(pet.bondUnpaid ?? 0));
  const cleared = { ...pet, bondHalves: 0, bondUnpaid: 0 };
  if (unpaid <= 0) return cleared;

  const grown = gainExp(pet.level, pet.exp, expForHalfHeart(pet.level) * unpaid);
  return { ...cleared, level: grown.level, exp: grown.exp };
}

// Index of the hour slot `date` falls in, or null when the window is closed.
export function bondSlotAt(date) {
  const { startHour } = bondWindow(date);
  const hours = date.getHours() + date.getMinutes() / 60;
  const slot = Math.floor(hours - startHour);
  return slot >= 0 && slot < SLOTS_PER_DAY ? slot : null;
}

export function heartsFromHalves(halves) {
  const h = Number(halves);
  if (!Number.isFinite(h) || h <= 0) return 0;
  return Math.min(MAX_HEARTS, h / HALVES_PER_HEART);
}

// Each half heart is also worth half a percent of the level the buddy is on, so a
// full five-heart day hands over 5% of that bar -- and, because the bar narrows as
// levels get cheap and widens as they get dear, the reward always means the same
// thing in progress terms rather than in raw points.
export function expForHalfHeart(level) {
  return expToNextLevel(level) / 200;
}

// Credit the hours the device recorded while nothing was listening -- the
// commute, mostly. `offline` is what parseOfflineBond returned: one day and the
// hours a KEY press happened in.
//
// **Idempotent, and that is the design rather than a nicety.** applyBondTick
// refuses a slot whose bit is already in `bondSlots`, so replaying a mask the
// host has already applied changes nothing at all. That is what lets the device
// republish the same mask every 30 seconds for the rest of the day and lets the
// whole feature work with no acknowledgement, no sequence numbers, and no
// delete-after-upload step -- the step that loses data when the upload fails
// after the delete.
//
// Hours from any other day are dropped. `bondSlots` is per-day and resets, so
// there is no honest way to credit yesterday, and pretending otherwise would
// either wipe today's progress or pay a slot twice.
export function applyOfflineBond(pet, { offline, now, today, epochDay } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("now is required");
  if (!offline || !Array.isArray(offline.hours) || offline.hours.length === 0) return pet;
  if (offline.epochDay !== epochDay) return pet;

  let next = pet;
  for (const hour of offline.hours) {
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    // The device cannot have recorded an hour that has not happened yet. If it
    // claims one the two clocks disagree, and crediting early is the wrong way
    // to be wrong -- the hour comes round on its own a moment later.
    if (hour > now.getHours()) continue;
    const at = new Date(now);
    at.setHours(hour, 0, 0, 0);
    next = applyBondTick(next, { now: at, clicked: true, today });
  }
  return next;
}

export function applyBondTick(pet, { now, clicked = false, today } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("now is required");
  if (typeof today !== "string" || today.length === 0) throw new Error("today is required");

  const fresh = pet.bondDay === today;
  // A day that rolled over without ever reaching its own 19:00 -- the device
  // was off, or the host was -- still owes whatever it earned. Settle before
  // resetting, or the halves are simply lost.
  const carried = fresh ? pet : settleBondExp(pet);
  const halves = fresh ? Math.max(0, Number(carried.bondHalves ?? 0)) : 0;
  const credited = fresh ? Math.max(0, Number(carried.bondSlots ?? 0)) : 0;
  const unpaid = fresh ? Math.max(0, Number(carried.bondUnpaid ?? 0)) : 0;

  const base = {
    ...carried, bondDay: today, bondHalves: halves, bondSlots: credited, bondUnpaid: unpaid,
  };

  const slot = bondSlotAt(now);
  // Past the day's last slot: pay out and leave the hearts on the panel, which
  // are the day's record and stay until midnight rolls them over.
  if (slot == null) return bondWindowClosed(now) ? settleBondExp(base) : base;

  const mask = 1 << slot;
  if ((credited & mask) !== 0) return base;
  if (!bondWindow(now).auto && !clicked) return base;

  // No exp here. It is owed, not paid -- see settleBondExp.
  return {
    ...base,
    bondUnpaid: Math.min(SLOTS_PER_DAY, unpaid + 1),
    // The cumulative bond that drives friendship evolutions keeps its old pace:
    // ten half hearts add up to exactly one active day's worth under the previous
    // rules, so the ~2-week Eevee threshold still means ~2 weeks.
    bond: Math.min(PARAMS.bondSoftCap, Number(base.bond ?? 0) + PARAMS.bondPerActiveDay / SLOTS_PER_DAY),
    bondHalves: Math.min(SLOTS_PER_DAY, halves + 1),
    bondSlots: credited | mask,
  };
}
