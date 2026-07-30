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
function expForHalfHeart(level) {
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
  const halves = fresh ? Math.max(0, Number(pet.bondHalves ?? 0)) : 0;
  const credited = fresh ? Math.max(0, Number(pet.bondSlots ?? 0)) : 0;

  const base = { ...pet, bondDay: today, bondHalves: halves, bondSlots: credited };

  const slot = bondSlotAt(now);
  if (slot == null) return base;

  const mask = 1 << slot;
  if ((credited & mask) !== 0) return base;
  if (!bondWindow(now).auto && !clicked) return base;

  const grown = gainExp(base.level, base.exp, expForHalfHeart(base.level));
  return {
    ...base,
    level: grown.level,
    exp: grown.exp,
    // The cumulative bond that drives friendship evolutions keeps its old pace:
    // ten half hearts add up to exactly one active day's worth under the previous
    // rules, so the ~2-week Eevee threshold still means ~2 weeks.
    bond: Math.min(PARAMS.bondSoftCap, Number(base.bond ?? 0) + PARAMS.bondPerActiveDay / SLOTS_PER_DAY),
    bondHalves: Math.min(SLOTS_PER_DAY, halves + 1),
    bondSlots: credited | mask,
  };
}
