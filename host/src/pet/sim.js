export const PARAMS = {
  dailyExpCap: 100,
  expPerKTok: 2,
  levelExp: 100,
  levelDaysCap: 20,
  bondPerActiveDay: 4,
  bondSoftCap: 180,
  evolveBond: 56,
  costSpikeUSD: 30,
};

// EXP is denominated in days: dailyExpCap === levelExp, so one full day of usage
// is worth exactly 1 day of EXP and a light day earns a fraction of one. The only
// knob the level curve turns is therefore "how many days does this level cost",
// which is what makes the segmented EXP bar readable as day cells.
//
// The curve is deliberately Pokémon-flavoured: the first levels land in a day or
// two, then each one stretches out. levelDaysCap keeps the tail from running away
// -- past that point every level costs the same, so a long-lived buddy still moves.
export function daysToNextLevel(level) {
  const l = Math.max(1, Math.floor(Number(level) || 1));
  return Math.min(PARAMS.levelDaysCap, 1 + Math.floor((l * (l + 1)) / 6));
}

export function expToNextLevel(level) {
  return daysToNextLevel(level) * PARAMS.levelExp;
}

// Widest a single level can ever be -- the static upper bound state.js validates
// a persisted `exp` against before the per-level clamp narrows it.
export const MAX_LEVEL_EXP = PARAMS.levelDaysCap * PARAMS.levelExp;

export function deriveMood({ p5h, todayCost, rateStale } = {}) {
  if (Number.isFinite(todayCost) && todayCost >= PARAMS.costSpikeUSD) return "shocked";
  if (rateStale || !Number.isFinite(p5h)) return "focused"; // unknown utilization -> neutral, never falsely happy
  if (p5h >= 100) return "fainted";
  if (p5h >= 80) return "strained";
  if (p5h >= 50) return "focused";
  return "happy";
}

export function applyDailyGrowth(pet, { todayTokens, today } = {}) {
  if (typeof today !== "string" || today.length === 0) {
    throw new Error("today is required");
  }
  const credited = dailyGrowthCredit(todayTokens);
  const dateRegressed = typeof pet.lastGrowthDay === "string" && pet.lastGrowthDay > today;
  const sameDay = pet.lastGrowthDay === today || dateRegressed;
  // Newborn (or never-credited) on a known day: anchor today's already-spent usage as the
  // baseline so the pet earns EXP only from tokens spent AFTER it was created. Without this,
  // a pet born mid-day retroactively claims the whole day's exp (= one full level, since
  // dailyExpCap === levelExp) and jumps straight to Lv.2.
  const firstEver = pet.lastGrowthDay == null;
  const creditedExp = sameDay ? Number(pet.todayCreditedExp ?? 0) : (firstEver ? credited.exp : 0);
  const creditedBond = sameDay ? Number(pet.todayCreditedBond ?? 0) : 0;
  const expGain = Math.max(0, credited.exp - creditedExp);
  const bondGain = Math.max(0, credited.bond - creditedBond);
  // Each level has its own cost (see daysToNextLevel), so drain the pool one level
  // at a time instead of dividing by a single constant -- a big carry-over still
  // levels more than once, it just pays the (rising) price for each.
  let level = Math.max(1, Math.floor(Number(pet.level) || 1));
  let exp = pet.exp + expGain;
  while (exp >= expToNextLevel(level)) {
    exp -= expToNextLevel(level);
    level += 1;
  }
  const bond = Math.min(PARAMS.bondSoftCap, pet.bond + bondGain);

  return {
    ...pet,
    level,
    exp,
    bond,
    expGain,
    todayCreditedExp: Math.max(creditedExp, credited.exp),
    todayCreditedBond: Math.max(creditedBond, credited.bond),
    lastGrowthDay: dateRegressed ? pet.lastGrowthDay : today,
  };
}

function dailyGrowthCredit(todayTokens) {
  const tokens = Math.max(0, Number(todayTokens ?? 0));
  return {
    exp: Math.min(
      PARAMS.dailyExpCap,
      Math.floor(tokens / 1000) * PARAMS.expPerKTok,
    ),
    bond: tokens > 0 ? PARAMS.bondPerActiveDay : 0,
  };
}
