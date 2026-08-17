const DAY_MS = 86_400_000;

export function settleDays(
  pet,
  today,
  { usedDays, maxCatchupDays = 30, bondDecayPerMissed = 3 },
) {
  if (!pet.lastSettled) return pet;

  const days = settlementWindow(pet.lastSettled, today, maxCatchupDays);
  if (days.length === 0) return pet;

  let bond = pet.bond;
  let streak = pet.streak;
  let shield = pet.shield;
  let careCount = Math.max(0, Number(pet.careCount ?? 0));

  for (const day of days) {
    careCount = Math.max(0, careCount - 1);
    if (usedDays.has(day)) {
      streak += 1;
      if (streak % 7 === 0) shield = Math.min(2, shield + 1);
    } else if (shield > 0) {
      shield -= 1;
    } else {
      streak = 0;
      bond = Math.max(0, bond - bondDecayPerMissed);
    }
  }

  return { ...pet, bond, streak, shield, careCount, lastSettled: days.at(-1) };
}

export function settlementWindow(lastSettled, today, maxCatchupDays = 30) {
  if (!lastSettled) return [];
  return daysBetween(lastSettled, today, maxCatchupDays);
}

export function activeDaysFromUsage(usage) {
  if (!usage || usage.ok === false) return null;
  // Empty array == "no history we can trust" -> null -> fail-open (never punish
  // for data we cannot see). Non-array (missing field) is treated the same.
  if (!Array.isArray(usage.activeDays) || usage.activeDays.length === 0) return null;
  return new Set(usage.activeDays);
}

// How many days of care history the save carries. Comfortably past
// maxCatchupDays (30), so a settlement can never look further back than the
// record goes; the file cost is a few hundred bytes.
export const MAX_CARE_DAYS = 45;

// The days the owner was demonstrably WITH the buddy, written into the save.
//
// ccusage answers a different question from the one the streak asks. It knows
// what was spent on THIS machine and nothing else, so two whole classes of day
// were being settled as missed: a day worked on the other PC (invisible here),
// and a day spent pressing KEY without opening Claude at all (invisible
// everywhere). Both are days the owner turned up, which is the only thing 「N天」
// claims to count. Measured cost of not having this: 2026-08-13 had 15 KEY
// presses and zero tokens on this machine, and the next morning's settlement
// zeroed a 17-day streak.
//
// It lives in the save rather than in a machine-local file on purpose: it then
// travels with the device, save-sync unions it the way it unions the dex, and a
// fresh machine with no usage history inherits the record instead of punishing
// the days it cannot see.
export function careDaySet(pet) {
  return new Set(normalizeCareDays(pet?.careDays));
}

export function normalizeCareDays(value, { maxDays = MAX_CARE_DAYS } = {}) {
  if (!Array.isArray(value)) return [];
  const days = [...new Set(value.filter(isYmd))].sort();
  return days.slice(-maxDays);
}

// Has today earned anything yet? A paid 亲密度 slot answers yes on its own --
// that is a button press on the device, the most direct evidence there is. The
// token clause is the same test buildUsedDays already applied to lastGrowthDay,
// kept so a day spent working and not petting still counts.
export function isCareDay(pet, today) {
  if (!pet || !isYmd(today)) return false;
  if (
    pet.bondDay === today &&
    ((pet.bondHalves ?? 0) > 0 || (pet.bondUnpaid ?? 0) > 0 || (pet.bondSlots ?? 0) > 0)
  ) {
    return true;
  }
  return (
    pet.lastGrowthDay === today &&
    ((pet.todayCreditedExp ?? 0) > 0 || (pet.todayCreditedBond ?? 0) > 0)
  );
}

// Called once a tick. Returns the pet unchanged -- same object -- when there is
// nothing to add, so a save that has never earned a care day round-trips
// byte-identical and save-sync has nothing to churn on.
export function recordCareDay(pet, today, { maxDays = MAX_CARE_DAYS } = {}) {
  if (!isCareDay(pet, today)) return pet;
  const days = normalizeCareDays(pet.careDays, { maxDays });
  if (days.includes(today)) return pet;
  return { ...pet, careDays: normalizeCareDays([...days, today], { maxDays }) };
}

// 「N天」 -- days together. It counts CALENDAR days and nothing else.
//
// It used to be `streak`, the settlement counter, and that is a different
// question: streak asks "did you show up", and every source of that evidence is
// blind to a day when no host ran anywhere. ccusage sees one machine's tokens;
// careDays sees only days a host was up to write one. So a weekend with both
// PCs off reads as absence -- measured 2026-08-17, 19 天 -> 0 天 over 08-15/16,
// the third time this same blind spot has been paid for.
//
// The owner's call, and it settles the question rather than patching it again:
// the number says how long the two of them have been together, so it advances
// with the date and nothing can take a day back. A powered-down weekend, a flat
// battery, a fortnight's holiday -- none of them are days they stopped being
// together, and none of them can be told apart from each other by anything the
// host can see.
//
// `streak` is untouched and still settles exactly as it did: it grants the
// shield and drives the bond decay, which ARE about care and should notice an
// absent day. It is simply no longer what the panel shows.
export function daysTogether(pet, today) {
  const since = togetherSinceOf(pet, today);
  if (!isYmd(since) || !isYmd(today) || today < since) return 0;
  return daySpan(since, today) + 1; // inclusive: the day you met is day 1
}

// The anchor, and where it comes from when a save predates the field.
//
// Derived from the settled streak rather than defaulted to today, so a save
// arriving from the other machine keeps the number it was already showing
// instead of restarting at 1. `lastSettled` is the day `streak` counts through,
// and the count is inclusive, hence streak - 1.
export function togetherSinceOf(pet, today) {
  if (isYmd(pet?.togetherSince)) return pet.togetherSince;
  const streak = Number(pet?.streak ?? 0);
  if (isYmd(pet?.lastSettled) && Number.isFinite(streak) && streak > 0) {
    return addDays(pet.lastSettled, -(streak - 1));
  }
  return isYmd(today) ? today : null;
}

// Written once, on the tick, beside recordCareDay. Returns the pet unchanged --
// same object -- when the anchor is already there, so a save that has one
// round-trips byte-identical and save-sync has nothing to churn on.
export function recordTogetherSince(pet, today) {
  if (!pet || isYmd(pet.togetherSince)) return pet;
  const since = togetherSinceOf(pet, today);
  if (!isYmd(since)) return pet;
  return { ...pet, togetherSince: since };
}

function isYmd(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function daySpan(from, to) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const delta = Math.floor((Number(end) - Number(start)) / DAY_MS);
  return Number.isFinite(delta) ? delta : 0;
}

function addDays(day, offset) {
  const base = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(Number(base))) return null;
  return toYmd(new Date(Number(base) + offset * DAY_MS));
}

export function buildUsedDays(pet, today, usage, { maxCatchupDays = 30 } = {}) {
  const window = settlementWindow(pet.lastSettled, today, maxCatchupDays);
  const used = new Set();
  if (window.length === 0) return used;

  const active = activeDaysFromUsage(usage);
  if (!active) {
    // History unavailable -> cannot prove inactivity -> fail-open (no decay).
    for (const day of window) used.add(day);
    return used;
  }

  // Earliest day ccusage knows about; days before it are unknown -> fail-open.
  let knownFrom = null;
  for (const day of active) {
    if (knownFrom === null || day < knownFrom) knownFrom = day;
  }

  // The save's own record stands beside ccusage, never against it: a day either
  // side calls active is active. Neither source can prove a day was missed --
  // ccusage only sees this machine, and the care record only sees days a host
  // was running -- so the union is the only reading that does not invent
  // absence out of a blind spot.
  const cared = careDaySet(pet);

  for (const day of window) {
    if (active.has(day) || cared.has(day) || (knownFrom !== null && day < knownFrom)) used.add(day);
  }

  // The in-progress last growth day, if it already earned, counts as used.
  if (
    pet.lastGrowthDay &&
    pet.lastGrowthDay < today &&
    ((pet.todayCreditedExp ?? 0) > 0 || (pet.todayCreditedBond ?? 0) > 0)
  ) {
    used.add(pet.lastGrowthDay);
  }

  return used;
}

function daysBetween(from, to, maxCatchupDays) {
  const days = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const deltaDays = Math.floor((Number(end) - Number(start)) / DAY_MS);
  if (!Number.isFinite(deltaDays) || deltaDays <= 1) return days;

  const count = Math.min(deltaDays - 1, Math.max(0, Math.floor(maxCatchupDays)));
  const firstOffset = deltaDays - count;
  for (let offset = firstOffset; offset < deltaDays; offset += 1) {
    const current = new Date(Number(start) + offset * DAY_MS);
    days.push(toYmd(current));
  }

  return days;
}

function toYmd(date) {
  return date.toISOString().slice(0, 10);
}
