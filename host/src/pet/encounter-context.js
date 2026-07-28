// Everything the encounter conditions are allowed to know, assembled from what
// the tick already has in hand. One place, so that "the device cannot actually
// measure that" is a question with a single answer.
//
// The rule for every field: supply it only when it is genuinely known. A missing
// field fails the conditions that need it (see PREDICATES in encounter.js), which
// is the correct outcome -- a tick before the first weather fetch should mean "no
// weather-gated species right now", never a default that quietly stands in for a
// real reading. So: null, not 0; absent, not guessed.

import { evolutionRoot } from "./species-meta.js";
import { normalizeDex } from "./dex.js";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Night is the panel's own quiet stretch rather than a solar calculation: the
// device has no almanac, and "is it dark out" is a question about the owner's
// evening, not about the horizon.
const NIGHT_FROM_HOUR = 19;
const NIGHT_BEFORE_HOUR = 6;

export function weekdayKey(date) {
  return WEEKDAYS[date.getDay()];
}

export function isNight(hour) {
  return hour >= NIGHT_FROM_HOUR || hour < NIGHT_BEFORE_HOUR;
}

export function buildEncounterContext({ pet = {}, usage = {}, weather = {}, room, mood, now } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("buildEncounterContext: now is required");
  }

  const hour = now.getHours();
  const dex = normalizeDex(pet);

  return {
    hour,
    night: isNight(hour),
    daytime: !isNight(hour),
    weekday: weekdayKey(now),

    // Outdoor readings come from the forecast; a degraded snapshot still carries
    // its last good numbers, which is why `degraded` is not a reason to withhold
    // them. `kind` is resolved in weather.js from the WMO code.
    weatherKind: weather?.kind ?? null,
    temp: numberOrNull(weather?.temp),
    humidity: numberOrNull(weather?.humidity),
    wind: numberOrNull(weather?.wind),

    // Indoor readings come off the device's own sensor, so they are absent
    // whenever it is unplugged or the sensor has not reported yet.
    roomTemp: numberOrNull(room?.temp),
    battery: numberOrNull(room?.battery),

    level: numberOrNull(pet.level),
    bond: numberOrNull(pet.bond),
    streak: numberOrNull(pet.streak),
    careCount: numberOrNull(pet.careCount),

    dexCaught: dex.dexCaught.length,
    caughtList: dex.dexCaught,
    // What hatched from the egg, not what is on the panel today.
    starter: pet.species ? evolutionRoot(pet.species) : null,

    p5h: numberOrNull(usage?.p5h),
    pweek: numberOrNull(usage?.pweek),
    mood: mood ?? null,
  };
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
