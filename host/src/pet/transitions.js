import { rollPersonality } from "./personality.js";
import { resolveEvolution } from "./evolution.js";
import { normalizeDex, recordSeen } from "./dex.js";

export function ensurePet(state, today, personalityRng = Math.random) {
  // No hatched flag = fresh start (or pre-hatched dirty save) -> newborn from bond 0.
  // The onboarding gate handles species choice + hatch; ensurePet is the no-gate
  // fallback (tests / CPB_ONCE) and births a plain eevee.
  if (!state?.hatched) {
    return {
      species: "eevee",
      level: 1,
      exp: 0,
      bond: 0,
      streak: 0,
      shield: 0,
      lastSettled: today,
      lastGrowthDay: null,
      todayCreditedExp: 0,
      todayCreditedBond: 0,
      hatched: true,
      ...rollPersonality(personalityRng),
    };
  }

  const pet = {
    species: "eevee",
    level: 1,
    exp: 0,
    bond: 0,
    streak: 0,
    shield: 0,
    lastSettled: today,
    lastGrowthDay: null,
    todayCreditedExp: 0,
    todayCreditedBond: 0,
    ...state,
  };
  return hasPersonality(pet) ? pet : { ...pet, ...rollPersonality(personalityRng) };
}

export function applyPetTransitions({
  pet,
  weather,
  room,
  now,
  buttonEvents = [],
  evolutionIntents,
} = {}) {
  let next = applyCareEvents(pet, buttonEvents);
  let evolutionAnimation = null;
  let choiceEvolved = false;

  for (const intent of drainEvolutionIntents(evolutionIntents)) {
    if (intent?.type === "stone" && isEvolutionStone(intent.stone)) {
      next = { ...next, stone: intent.stone };
    } else if (intent?.type === "choose" && typeof intent.to === "string") {
      const choice = resolveEvolution(next.species, evolutionContext({ pet: next, weather, room, now }))
        .candidates
        .find((candidate) => candidate.to === intent.to);
      if (choice) {
        const fromSpecies = next.species;
        next = evolvePet(next, choice.to);
        evolutionAnimation = { fromSpecies, toSpecies: choice.to };
        choiceEvolved = true;
        break;
      }
    }
  }

  // Table-driven: resolve once against the evolution tables, recompute readiness
  // every tick (can fall back to false), and reuse the same resolution for KEY.
  const evolution = choiceEvolved
    ? { auto: null, candidates: [] }
    : resolveEvolution(next.species, evolutionContext({ pet: next, weather, room, now }));
  if (!choiceEvolved && next.stone && !hasMatchingStoneCandidate(evolution.candidates, next.stone)) {
    const { stone, ...withoutStone } = next;
    next = withoutStone;
  }
  const reconciledEvolution = choiceEvolved
    ? evolution
    : resolveEvolution(next.species, evolutionContext({ pet: next, weather, room, now }));
  const readyToEvolve = Boolean(reconciledEvolution.auto || reconciledEvolution.candidates.length > 0);
  next = reconcilePendingCandidates({ ...next, readyToEvolve }, reconciledEvolution);

  if (!choiceEvolved && readyToEvolve && hasKeyPress(buttonEvents)) {
    if (reconciledEvolution.auto) {
      const fromSpecies = next.species;
      const toSpecies = reconciledEvolution.auto;
      next = evolvePet(next, toSpecies);
      evolutionAnimation = { fromSpecies, toSpecies };
    }
  }

  return { pet: next, evolutionAnimation };
}

export function applyCareEvents(pet, events = []) {
  if (!events.some((event) => event?.key === "KEY" && event?.kind === "long")) return pet;
  return { ...pet, careCount: Math.max(0, Number(pet.careCount ?? 0)) + 1 };
}

export function evolutionContext({ pet, weather, room, now }) {
  const hour = now.getHours();
  const daytime = hour >= 6 && hour < 18;
  const careCount = Math.max(0, Number(pet.careCount ?? 0));

  return {
    bond: pet.bond,
    level: pet.level,
    daytime,
    night: !daytime,
    care: careCount > 0,
    careCount,
    roomTemp: room?.t,
    roomHumidity: room?.h,
    weather: weather?.cond,
    temp: weather?.temp,
    humidity: weather?.humidity,
    warmHumid: isWarmHumid(weather?.temp, weather?.humidity) || isWarmHumid(room?.t, room?.h),
    cold: isCold(weather?.temp) || isCold(room?.t),
    stone: pet.stone,
  };
}

// Evolving is not catching, and the owner spelled out the difference on
// 2026-08-03 when he asked what happens if his buddy evolves into something he
// already owns:
//
//   * **捕捉 does not move.** Nothing was caught. `capturedCount` counts
//     captures, and an evolution is the same pokemon changing shape.
//   * **图鉴 +1 if the new form was not already lit**, which is what `recordSeen`
//     does and the only thing it does.
//   * **If that species is already in the box, the HIGHER LEVEL one survives.**
//     Not the newer, not the boxed one: the higher. Two records for one species
//     is the state that must not exist -- `rosterEntries` would show one and
//     silently strand the other, which is how a pokemon appears to have lost
//     levels.
//
// The fields carried across are the same short list `swapActiveBuddy` uses --
// identity, growth, personality -- and for the same reason: everything else is
// the trainer's day bookkeeping and belongs to the day, not to the pokemon.
export function evolvePet(pet, species) {
  const { pendingCandidates, stone, ...rest } = pet;
  const evolved = { ...rest, species, readyToEvolve: false };

  const dex = normalizeDex(pet);
  const stored = dex.box.find((entry) => entry.species === species) ?? null;
  const seen = recordSeen(dex, species);          // 图鉴 +1 if new; never touches capturedCount

  // Strictly greater, so a tie keeps the one that just evolved. It is the one
  // on the panel and the one whose IVs and nature the owner has been looking
  // at; swapping it out for an identical-level twin would be a change he could
  // see (nature is on the panel) for no reason he could.
  const keepStored = stored != null && (stored.level ?? 0) > (evolved.level ?? 0);
  const winner = keepStored
    ? {
        ...evolved,
        level: stored.level ?? evolved.level,
        exp: stored.exp ?? 0,
        bond: stored.bond ?? evolved.bond,
        iv: stored.iv ?? null,
        nature: stored.nature ?? null,
        characteristic: stored.characteristic ?? null,
        caughtAt: stored.caughtAt ?? evolved.caughtAt ?? null,
      }
    : evolved;

  return {
    ...winner,
    dexCaught: seen.dexCaught,
    capturedCount: seen.capturedCount,
    // The active buddy lives on the panel, not in the box. Leaving the boxed
    // copy behind is what would duplicate the species.
    box: seen.box.filter((entry) => entry.species !== species),
  };
}

export function drainEvolutionIntents(evolutionIntents) {
  if (Array.isArray(evolutionIntents)) return evolutionIntents;
  if (!evolutionIntents || typeof evolutionIntents.drain !== "function") return [];
  const drained = evolutionIntents.drain();
  return Array.isArray(drained) ? drained : [];
}

function hasPersonality(pet) {
  return Boolean(
    typeof pet.nature === "string" &&
      pet.nature.length > 0 &&
      Array.isArray(pet.iv) &&
      pet.iv.length === 6 &&
      pet.iv.every((value) => Number.isInteger(value) && value >= 0 && value <= 31) &&
      typeof pet.characteristic === "string" &&
      pet.characteristic.length > 0,
  );
}

function hasKeyPress(events) {
  return events.some((event) => event?.key === "KEY" && event?.kind === "short");
}

function reconcilePendingCandidates(pet, evolution) {
  const { pendingCandidates, ...withoutPendingCandidates } = pet;
  if (!evolution.auto && evolution.candidates.length > 1) {
    return { ...withoutPendingCandidates, pendingCandidates: evolution.candidates };
  }
  return withoutPendingCandidates;
}

function hasMatchingStoneCandidate(candidates, stone) {
  return candidates.some((candidate) => candidate?.needs?.stone === stone);
}

function isEvolutionStone(stone) {
  return stone === "water" || stone === "thunder" || stone === "fire";
}

function isWarmHumid(temp, humidity) {
  return typeof temp === "number" && typeof humidity === "number" && temp >= 20 && humidity >= 60;
}

function isCold(temp) {
  return typeof temp === "number" && temp <= 4;
}
