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
