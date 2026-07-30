// ⚠️ SPOILERS — 主人请勿阅读 / owner: do not read this file ⚠️
//
// This is the encounter design: which of the 151 shows up, how often, and what
// has to be true for it to show up at all. The owner asked to be surprised by
// all of it, so it is written here and nowhere else -- not in chat, not in the
// handoff, not in a test name. The runtime engine (src/pet/encounter.js) is
// deliberately free of species knowledge so it can be read and reviewed
// without giving anything away.
//
// Run from host/: node scripts/gen-encounters.mjs  ->  seed/encounters.json
//
// ---------------------------------------------------------------------------
// Capture difficulty — decided by the owner 2026-07-30, filed here because it
// is part of the same surprise and he asked for it to stay out of chat.
//
// The capture screen's slider is tuned FROM `capture_rate` in seed/pokedex.json:
// that number sets the width of B and C and the speed the piece slides at. So
// the rates already collected in P1 stay the difficulty knob -- a rare species
// is hard because its window is narrow and fast, not because a hidden roll went
// against you. Nothing else consumes capture_rate; if this is ever abandoned,
// the field becomes dead and should be removed rather than left to imply a
// mechanic that is not there.
//
// The mechanic itself (bar, fixed line A, sliding B, surrounding C, and what
// each landing means) is in docs/handoff.md, which is safe -- it gives away no
// species. Only the mapping from species to difficulty belongs in this file.
//
// ---------------------------------------------------------------------------
// Pacing, and where the numbers came from
//
// Target: all 151 in six months to a year of ordinary use. The device is on
// roughly 09:00-24:00, i.e. ~900 host ticks a day. At ENCOUNTER_DEFAULTS'
// per-tick chance that is ~2.5 encounters a day, ~900 a year. Coupon-collector
// on 151 unequal weights would spend most of that year on the last handful, so
// already-caught species are down-weighted (see caughtWeight) and the pool
// drifts toward what is missing. scripts/sim-encounters.mjs runs the real
// engine over a simulated year and reports the completion curve -- change a
// weight here, re-run that, do not reason about it in your head.
//
// Rarity comes from the games' own capture_rate rather than a hand-made tier
// list: Game Freak already answered "how common is this", and pokedex.json
// carries the answer. Legendaries are pulled out separately because their
// capture rate (3) understates how special they should feel here.
//
// Conditions come from what the species IS in the games -- habitat, type, and
// the flavour everyone remembers. The device can observe time of day, weather,
// temperature, humidity, wind, room temperature, battery, bond, level, streak,
// care count, Claude usage, mood, weekday, and pokedex progress; every gate
// below is built from those and nothing else.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const POKEDEX = JSON.parse(readFileSync(new URL("../seed/pokedex.json", import.meta.url), "utf8"));
const RARITY = JSON.parse(readFileSync(new URL("../seed/wild-rarity.json", import.meta.url), "utf8"));
const OUT = fileURLToPath(new URL("../seed/encounters.json", import.meta.url));

const WILD = new Map(RARITY.species.map((entry) => [entry.key, entry]));

// How AVAILABLE the games make a species, as opposed to how catchable.
//
// `capture_rate` (baseWeight, below) answers "how hard is this to catch once you
// have found it". It says nothing about how often you find it, and using it alone
// was wrong in a way the owner spotted on 2026-07-30: a stage-2 pokemon turned up
// as casually as a stage-1 one, which is not how the games behave. Canonically,
// on foot in Generation 1:
//
//   base forms      49 of 68 meetable, median walkChanceSum 80
//   first evos      39 of 64 meetable, median 30
//   second evos      2 of 19 meetable, median 18
//   and 61 of the 151 cannot be met on foot at all
//
// So availability is its own axis and it comes from seed/wild-rarity.json, which
// is generated from PokeAPI by scripts/gen-wild-rarity.mjs -- not from anyone's
// sense of which pokemon feel rare. Re-run that script, not your memory.
//
// The 61 that never appear on foot are floored at NEVER_ON_FOOT rather than
// removed. In the games those come from evolution, a trade, a rod or a static
// encounter; here a caught pokemon CAN be swapped onto the panel and evolved to
// fill its line's entries (see roster.js), but it has to be swapped in one at a
// time, so leaving 61 species obtainable only that way would be a year of
// babysitting. They stay findable in the wild, just rarely.
//
// STRENGTH blends the canonical ratio toward neutral. It ended up at 1.0 -- i.e.
// no blending, pure canonical data, no invented coefficient anywhere in the
// weights -- but it is kept as a knob because getting there needed the two
// changes below and someone may need to back it off again.
//
// Measured with sim-encounters.mjs, 40 runs, 400-day horizon, same seeds:
//
//   pre-change table                    40/40, median 331, slowest 393
//   STRENGTH 1.0, old caughtWeight      0/40   <- looked like proof it was impossible
//   STRENGTH 0.65, old caughtWeight    31/40, median 343
//   STRENGTH 0.30, old caughtWeight    37/40, median 336
//   STRENGTH 1.0, caughtWeight 0.0015  40/40, median 316, slowest 351  <- current
//
// The first attempt read as "canonical rarity is incompatible with a completable
// pokedex". It was not: completion time is dominated by the TAIL, and the tail was
// being starved by encounters spent on species already in the dex. Dropping
// caughtWeight from 0.008 to 0.0015 (see below) freed enough of the pool that full
// canonical rarity became affordable AND completion got faster than it was before
// any of this. Raising perTickChance barely moved it by comparison -- throughput is
// not the constraint, and 0.0065 -> 0.0095 bought only 13 days.
//
// So: do not reason about these in your head, and do not conclude a target is
// impossible from one failed setting. Re-run the simulation.
const STRENGTH = 1.0;
const NEVER_ON_FOOT = 0.40;
const AVAILABILITY_REFERENCE = 80;   // the median base form, i.e. "ordinary"
const AVAILABILITY_CEILING = 1.6;

function availability(species) {
  const wild = WILD.get(species.key);
  if (!wild) return 1;                       // absent from the dataset: unchanged
  const raw = wild.walkAreas === 0
    // Square-rooted, not linear: the busiest species is ~330 against a median of
    // 80, and a raw ratio would let it eat the pool the way the old flat
    // capture_rate curve let evolved forms eat it.
    ? NEVER_ON_FOOT
    : Math.min(AVAILABILITY_CEILING, Math.max(NEVER_ON_FOOT, Math.sqrt(wild.walkChanceSum / AVAILABILITY_REFERENCE)));
  return 1 + STRENGTH * (raw - 1);
}

// Base weight by how catchable the games say it is. The curve is deliberately
// flatter than capture_rate itself (255 vs 3 is 85x; this is 100 vs 1.5) --
// raw ratios would mean the rarest tier effectively never appears inside a
// year, and the whole point is that it appears, rarely, under conditions.
function baseWeight(species) {
  if (species.isMythical) return 1.5;
  if (species.isLegendary) return 2.5;
  const rate = species.captureRate;
  if (rate >= 190) return 100;
  if (rate >= 120) return 55;
  if (rate >= 75) return 28;
  if (rate >= 45) return 14;
  if (rate >= 30) return 6;
  return 3;
}

// --- condition vocabulary -------------------------------------------------
// Small named pieces, composed per species below, so the intent stays legible
// and a change to "what night means" happens in one place.
const NIGHT = { night: true };
const DAY = { daytime: true };
const RAIN = { weather: ["rain"] };
const SNOW = { weather: ["rain"], tempBelow: 12 };  // Auckland has no snow; cold rain is the local equivalent
const CLEAR = { weather: ["sun"] };
const FOG = { weather: ["fog"] };
const WARM = { tempAtLeast: 19 };
const COLD = { tempBelow: 12 };
const HUMID = { humidityAtLeast: 70 };
const WINDY = { windAtLeast: 25 };
const LATE = { hourFrom: 21 };
const EARLY = { hourBefore: 11 };
const INDOORS_WARM = { roomTempAtLeast: 22 };
const INDOORS_COLD = { roomTempBelow: 18 };
const BUSY = { usageAtLeast: 60 };          // you are hammering Claude
const IDLE = { usageBelow: 15 };            // a quiet stretch
const HEAVY_WEEK = { weekUsageAtLeast: 55 };
const WEEKEND = { weekday: ["sat", "sun"] };
const LOYAL = { bondAtLeast: 90 };
const LONG_STREAK = { streakAtLeast: 14 };
const WELL_CARED = { careAtLeast: 40 };
const STUFFY = { humidityAtLeast: 78 };
const STRAINED = { mood: ["strained", "fainted"] };

// Per-species gates. Anything not listed is unconditional -- the common
// early-route wildlife that should just turn up, which is most of the dex.
const NEEDS = {
  // --- nocturnal ---------------------------------------------------------
  gastly: NIGHT, haunter: { ...NIGHT, dexAtLeast: 30 }, gengar: { ...NIGHT, ...LATE, dexAtLeast: 70 },
  zubat: NIGHT, golbat: { ...NIGHT, dexAtLeast: 25 },
  clefairy: { ...NIGHT, ...CLEAR }, clefable: { ...NIGHT, ...CLEAR, dexAtLeast: 60 },
  drowzee: NIGHT, hypno: { ...NIGHT, dexAtLeast: 45 },
  meowth: NIGHT, persian: { ...NIGHT, dexAtLeast: 40 },

  // --- weather -----------------------------------------------------------
  poliwag: RAIN, poliwhirl: { ...RAIN, dexAtLeast: 25 }, poliwrath: { ...RAIN, dexAtLeast: 65 },
  psyduck: RAIN, golduck: { ...RAIN, dexAtLeast: 45 },
  squirtle: { ...RAIN, notTheStarter: "squirtle", dexAtLeast: 40 },
  wartortle: { ...RAIN, notTheStarter: "squirtle", dexAtLeast: 70 },
  blastoise: { ...RAIN, notTheStarter: "squirtle", dexAtLeast: 110 },
  tentacool: { ...RAIN, ...HUMID }, tentacruel: { ...RAIN, ...HUMID, dexAtLeast: 60 },
  horsea: RAIN, seadra: { ...RAIN, dexAtLeast: 50 },
  staryu: { ...RAIN, ...NIGHT }, starmie: { ...RAIN, ...NIGHT, dexAtLeast: 60 },
  krabby: RAIN, kingler: { ...RAIN, dexAtLeast: 50 },
  shellder: RAIN, cloyster: { ...RAIN, ...COLD, dexAtLeast: 60 },
  seel: COLD, dewgong: { ...COLD, dexAtLeast: 55 },
  jynx: { ...COLD, ...NIGHT, dexAtLeast: 60 },
  lapras: { ...SNOW, dexAtLeast: 80 },
  articuno: { ...COLD, ...RAIN, dexAtLeast: 95, ...LONG_STREAK },

  charmander: { ...CLEAR, ...WARM, notTheStarter: "charmander", dexAtLeast: 40 },
  charmeleon: { ...CLEAR, ...WARM, notTheStarter: "charmander", dexAtLeast: 70 },
  charizard: { ...CLEAR, ...WARM, notTheStarter: "charmander", dexAtLeast: 110 },
  vulpix: { ...CLEAR, ...WARM }, ninetales: { ...CLEAR, ...WARM, dexAtLeast: 65 },
  growlithe: CLEAR, arcanine: { ...CLEAR, dexAtLeast: 60 },
  ponyta: { ...CLEAR, ...WARM }, rapidash: { ...CLEAR, ...WARM, dexAtLeast: 55 },
  magmar: { ...INDOORS_WARM, ...WARM, dexAtLeast: 70 },
  moltres: { ...CLEAR, ...WARM, dexAtLeast: 105, ...LONG_STREAK },

  // The starter line you DID pick is not out here to be caught -- it is the one
  // asleep on your desk. Its dex entries come from hatching it and evolving it
  // (dex.recordSeen), which is why the wild gate can stay this strict without
  // making 151 unreachable. The simulation proved that the hard way: with only
  // the gate and no recordSeen, three entries were unobtainable and every run
  // stalled three short of the end.
  bulbasaur: { ...HUMID, notTheStarter: "bulbasaur", dexAtLeast: 40 },
  ivysaur: { ...HUMID, notTheStarter: "bulbasaur", dexAtLeast: 70 },
  venusaur: { ...HUMID, notTheStarter: "bulbasaur", dexAtLeast: 110 },
  oddish: { ...NIGHT, ...HUMID }, gloom: { ...NIGHT, ...HUMID, dexAtLeast: 35 },
  vileplume: { ...NIGHT, ...HUMID, dexAtLeast: 70 },
  bellsprout: HUMID, weepinbell: { ...HUMID, dexAtLeast: 35 }, victreebel: { ...HUMID, dexAtLeast: 70 },
  exeggcute: { ...CLEAR, ...WARM }, exeggutor: { ...CLEAR, ...WARM, dexAtLeast: 65 },
  tangela: { ...HUMID, ...RAIN, dexAtLeast: 50 },
  paras: { ...HUMID, ...FOG }, parasect: { ...HUMID, ...FOG, dexAtLeast: 50 },

  pikachu: { ...LOYAL, dexAtLeast: 55 },
  raichu: { ...LOYAL, dexAtLeast: 90, ...WELL_CARED },
  voltorb: BUSY, electrode: { ...BUSY, dexAtLeast: 55 },
  magnemite: BUSY, magneton: { ...BUSY, dexAtLeast: 50 },
  electabuzz: { ...BUSY, ...HEAVY_WEEK, dexAtLeast: 70 },
  zapdos: { ...RAIN, ...WINDY, dexAtLeast: 105, ...HEAVY_WEEK },

  // --- underground / indoors --------------------------------------------
  diglett: EARLY, dugtrio: { ...EARLY, dexAtLeast: 45 },
  geodude: {}, graveler: { dexAtLeast: 40 }, golem: { dexAtLeast: 75 },
  onix: { dexAtLeast: 50 },
  sandshrew: { ...CLEAR, ...WARM }, sandslash: { ...CLEAR, ...WARM, dexAtLeast: 50 },
  machop: {}, machoke: { dexAtLeast: 45 }, machamp: { dexAtLeast: 80 },
  cubone: { ...NIGHT, ...FOG, dexAtLeast: 40 }, marowak: { ...NIGHT, ...FOG, dexAtLeast: 70 },
  grimer: STUFFY, muk: { ...STUFFY, dexAtLeast: 60 },
  koffing: STUFFY, weezing: { ...STUFFY, dexAtLeast: 60 },
  ditto: { dexAtLeast: 85 },
  chansey: { ...LOYAL, ...WELL_CARED, dexAtLeast: 90 },
  lickitung: { dexAtLeast: 60 },
  kangaskhan: { ...WELL_CARED, dexAtLeast: 75 },
  tauros: { ...WINDY, dexAtLeast: 70 },
  scyther: { ...CLEAR, dexAtLeast: 75 }, pinsir: { ...CLEAR, ...WARM, dexAtLeast: 75 },
  "mr-mime": { ...WEEKEND, dexAtLeast: 65 },
  snorlax: { ...IDLE, ...LATE, dexAtLeast: 80 },
  farfetchd: { ...WEEKEND, dexAtLeast: 70 },
  hitmonlee: { ...BUSY, dexAtLeast: 75 }, hitmonchan: { ...BUSY, dexAtLeast: 75 },
  porygon: { ...BUSY, ...LATE, dexAtLeast: 90 },
  aerodactyl: { ...FOG, dexAtLeast: 100 },
  omanyte: { ...RAIN, dexAtLeast: 85 }, omastar: { ...RAIN, dexAtLeast: 105 },
  kabuto: { ...RAIN, dexAtLeast: 85 }, kabutops: { ...RAIN, dexAtLeast: 105 },
  dratini: { ...RAIN, ...NIGHT, dexAtLeast: 95 },
  dragonair: { ...RAIN, ...NIGHT, dexAtLeast: 115 },
  dragonite: { ...RAIN, ...NIGHT, dexAtLeast: 125, ...LOYAL },
  gyarados: { ...RAIN, ...STRAINED, dexAtLeast: 70 },
  eevee: { ...LOYAL, dexAtLeast: 60 },
  vaporeon: { ...RAIN, dexAtLeast: 100 },
  jolteon: { ...BUSY, dexAtLeast: 100 },
  flareon: { ...CLEAR, ...WARM, dexAtLeast: 100 },

  // --- the two that end the game ----------------------------------------
  mewtwo: { dexAtLeast: 138, ...LATE, ...LONG_STREAK, ...HEAVY_WEEK },
  mew: { dexAtLeast: 145, ...LOYAL, ...WELL_CARED, ...LONG_STREAK, ...INDOORS_COLD },
};

// Rounded to 3dp so the generated file stays diffable; the engine normalises
// against the running total, so the absolute scale never matters.
const species = POKEDEX.species.map((s) => ({
  species: s.key,
  weight: Number((baseWeight(s) * availability(s)).toFixed(3)),
  ...(NEEDS[s.key] && Object.keys(NEEDS[s.key]).length > 0 ? { needs: NEEDS[s.key] } : {}),
}));

const unknownKeys = Object.keys(NEEDS).filter((key) => !POKEDEX.species.some((s) => s.key === key));

const out = {
  _doc: "SPOILERS. Generated by host/scripts/gen-encounters.mjs. The owner asked not to be told what is in here.",
  // How much weight a species keeps once it is already in the pokedex. Lowered
  // from 0.008 to 0.0015 on 2026-07-30, and it turned out to be the single most
  // effective number in this file: at 0.008 roughly a sixth of a late-game
  // encounter roll was still being spent re-offering species already collected,
  // which is exactly the encounters the tail needs. Dropping it took the median
  // completion from 331 days to 316 AND paid for full canonical rarity, which had
  // looked impossible at the old value (0/40 runs completing).
  //
  // Do not raise it back without re-running sim-encounters.mjs. Duplicates are
  // still wanted -- the 已捕获 tally counts them and meeting an old friend is part
  // of the point -- so this must stay non-zero.
  caughtWeight: 0.0015,
  species,
};

writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote seed/encounters.json: ${species.length} species, ${species.filter((s) => s.needs).length} gated`);
if (unknownKeys.length > 0) {
  // A typo'd key would silently make a species unconditional -- the opposite
  // of the intent, and invisible until someone noticed it turning up in the
  // wrong weather months later.
  console.warn(`WARNING: ${unknownKeys.length} condition key(s) match no species and were ignored: ${unknownKeys.join(", ")}`);
}
