export const PARAMS = {
  dailyExpCap: 100,
  expPerKTok: 2,
  levelExp: 100,
  maxLevel: 100,
  bondPerActiveDay: 4,
  bondSoftCap: 180,
  evolveBond: 56,
  costSpikeUSD: 30,
};

// EXP is denominated in days: dailyExpCap === levelExp, so a full day of usage is
// worth exactly one day of progress and a light day earns a fraction of one. The
// curve below then only has to answer one question -- how much of the road to
// Lv.100 does each level cover.
//
// Shape: a power curve, so early levels fall in a couple of hours and late ones
// take most of a day, which is what makes the species evolve on a Pokémon-ish
// schedule (the seed tables gate evolution on level 16/32/36) while a fully
// maxed buddy is still roughly a month of daily use away. The two constants are
// deliberately not round numbers and are not documented anywhere the owner
// reads -- the whole point is that the pace is discovered, not announced.
const CURVE_TOTAL_DAYS = 31;
const CURVE_SHAPE = 1.35;
const CURVE_TOTAL_EXP = CURVE_TOTAL_DAYS * PARAMS.levelExp;

function normalizeLevel(level) {
  const l = Math.floor(Number(level) || 1);
  return Math.max(1, Math.min(PARAMS.maxLevel, l));
}

// Total EXP burned getting from Lv.1 to `level`.
function cumulativeExp(level) {
  const l = normalizeLevel(level);
  return CURVE_TOTAL_EXP * ((l - 1) / (PARAMS.maxLevel - 1)) ** CURVE_SHAPE;
}

// Width of `level`'s own EXP bar. At the cap there is no next level, so the bar
// keeps the last level's width -- that way a maxed buddy reads as a full bar
// rather than dividing by zero.
export function expToNextLevel(level) {
  const l = normalizeLevel(level);
  const from = l >= PARAMS.maxLevel ? PARAMS.maxLevel - 1 : l;
  return Math.max(1, Math.round(cumulativeExp(from + 1) - cumulativeExp(from)));
}

// Widest a single level can ever be (the curve rises, so that is the last one) --
// the static upper bound state.js validates a persisted `exp` against before the
// per-level clamp narrows it.
export const MAX_LEVEL_EXP = expToNextLevel(PARAMS.maxLevel - 1);

// Add EXP and settle whatever levels it buys. Each level has its own cost, so the
// pool is drained one level at a time rather than divided by a constant -- a big
// carry-over still levels more than once, it just pays the rising price for each.
// Early levels are cheap enough that a single busy day is worth several of them.
export function gainExp(level, exp, amount) {
  let nextLevel = normalizeLevel(level);
  let nextExp = Math.max(0, Number(exp) || 0) + Math.max(0, Number(amount) || 0);

  while (nextLevel < PARAMS.maxLevel && nextExp >= expToNextLevel(nextLevel)) {
    nextExp -= expToNextLevel(nextLevel);
    nextLevel += 1;
  }
  // At the cap there is nothing left to spend EXP on: park the bar at full rather
  // than letting a maxed buddy accumulate an ever-growing invisible pool.
  if (nextLevel >= PARAMS.maxLevel) nextExp = Math.min(nextExp, expToNextLevel(PARAMS.maxLevel));

  return { level: nextLevel, exp: nextExp };
}

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
  const { level, exp } = gainExp(pet.level, pet.exp, expGain);
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
