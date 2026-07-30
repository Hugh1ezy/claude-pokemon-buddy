// Which pokemon is on the panel, and which of them can still grow.
//
// The owner's rule, 2026-07-30: you may display any species you own, including
// one you have already evolved past -- but a form you have evolved past is a
// keepsake, not a pet. It shows `Lv -` and five empty hearts, and it earns
// nothing. Only the furthest form you have reached in a line lives.
//
// The test is "do I own something this evolves into", not "does this evolve",
// which matters: a wild charmander you have never evolved is perfectly alive.
import { boxPet, normalizeDex } from "./dex.js";
import { SPECIES_DEX, evolutionDescendants, isDexSpecies } from "./species-meta.js";

export function isFrozenSpecies(species, dex) {
  const owned = new Set(normalizeDex(dex).dexCaught);
  return evolutionDescendants(species).some((later) => owned.has(later));
}

// The roster the pokedex screen can swap between: everything owned, in dex
// order, each with what the confirm screen has to show.
//
// The ACTIVE buddy is included. It lives on the panel rather than in the box,
// so without this the one pokemon you are certainly holding would be the one
// species you could not see the details of -- and swapping to a keepsake would
// be a one-way door.
export function rosterEntries(pet) {
  const dex = normalizeDex(pet);
  const owned = new Set(dex.dexCaught);
  if (typeof pet?.species === "string") owned.add(pet.species);

  return [...owned]
    .filter(isDexSpecies)
    .sort(byDexOrder)
    .map((species) => {
      const active = species === pet?.species;
      const stored = boxPet(dex, species);
      const source = active ? pet : stored;
      const frozen = isFrozenSpecies(species, dex);
      return {
        species,
        active,
        frozen,
        // A frozen form reports no level and no bond at all rather than a stale
        // number: it has not been growing, and showing the level it stopped at
        // reads as "this is its level" instead of "this one does not level".
        level: frozen ? null : (source?.level ?? null),
        bond: frozen ? null : (source?.bond ?? null),
        bondHalves: frozen ? null : (source?.bondHalves ?? null),
        caughtAt: stored?.caughtAt ?? (active ? pet?.caughtAt ?? null : null),
      };
    });
}

// Puts `species` on the panel and the current buddy back in the box.
//
// The buddy carries its whole record across -- level, exp, bond, personality --
// because the thing being swapped is which one you are LOOKING at, not which
// one exists. Returning to it later has to return to it, not to a reset copy.
export function swapActiveBuddy(pet, species) {
  const dex = normalizeDex(pet);
  if (!isDexSpecies(species) || species === pet?.species) return pet;

  const owned = new Set(dex.dexCaught);
  if (!owned.has(species)) return pet;

  const incoming = boxPet(dex, species);
  // Deliberately a SHORT list: identity, growth, personality. Everything else --
  // lastGrowthDay, lastSettled, todayCreditedExp/Bond, bondDay, bondHalves,
  // streak, shield -- is the trainer's day bookkeeping and stays exactly where
  // it is.
  //
  // That is not tidiness, it is the safe choice. Those fields drive settlement
  // and the "don't retroactively claim today's tokens" anchors; carrying a
  // week-old set in from the box would make the incoming pokemon either settle
  // a week it did not live through or claim a day it did not earn. Leaving them
  // put means a boxed pokemon is simply paused, which is also what it looks
  // like from outside.
  const outgoing = {
    species: pet.species,
    level: pet.level,
    exp: pet.exp,
    bond: pet.bond,
    iv: pet.iv,
    nature: pet.nature,
    characteristic: pet.characteristic,
    caughtAt: pet.caughtAt ?? null,
  };

  const box = dex.box.filter((entry) => entry.species !== species);
  if (isDexSpecies(outgoing.species)) box.push(outgoing);

  return {
    ...pet,
    ...withPetFields(incoming, species),
    dexCaught: dex.dexCaught.includes(species) ? dex.dexCaught : [...dex.dexCaught, species],
    capturedCount: dex.capturedCount,
    box: box.sort(byDexOrderOn("species")),
  };
}

// A box entry may be thin -- the starter line gets its dex entry from
// recordSeen, which never made a box copy -- so every field has a floor. A
// keepsake with no stored level is displayed as a keepsake, not as level
// undefined.
function withPetFields(stored, species) {
  return {
    species,
    level: stored?.level ?? 1,
    exp: stored?.exp ?? 0,
    bond: stored?.bond ?? 0,
    iv: stored?.iv ?? null,
    nature: stored?.nature ?? null,
    characteristic: stored?.characteristic ?? null,
    caughtAt: stored?.caughtAt ?? null,
    // Cleared rather than carried: whether the OUTGOING buddy was ready to
    // evolve says nothing about this one, and leaving it true would offer an
    // evolution the incoming pokemon has not earned.
    readyToEvolve: false,
  };
}

// While the buddy on the panel is a keepsake, the tick still runs every piece of
// its day bookkeeping -- the anchors have to keep moving or a later swap would
// let a live buddy claim a day it did not earn -- and then its level, exp and
// bond are put back where they were. Growth is pinned, not skipped.
export function pinFrozenGrowth(before, after) {
  return {
    ...after,
    level: before.level,
    exp: before.exp,
    bond: before.bond,
    expGain: 0,
  };
}

function byDexOrder(a, b) {
  return dexIndex(a) - dexIndex(b);
}

function byDexOrderOn(key) {
  return (a, b) => dexIndex(a?.[key]) - dexIndex(b?.[key]);
}

function dexIndex(species) {
  return SPECIES_DEX[species] ?? Number.MAX_SAFE_INTEGER;
}
