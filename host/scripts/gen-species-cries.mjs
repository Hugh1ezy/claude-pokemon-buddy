// Derive a cry for every one of the 151 from canonical data, and write
// seed/species-cries.json.
//
//   cd host && node scripts/gen-species-cries.mjs           # write the file
//   cd host && node scripts/gen-species-cries.mjs --dry     # print stats only
//
// The 18 cries that already existed were authored by hand. They are PRESERVED
// BYTE-FOR-BYTE: the buddy's own cry is a sound the owner already knows, and
// regenerating it into something else would be a silent change to the one part of
// this he hears every day. Only the other 133 are generated.
//
// Nothing here is a judgement about how a pokemon "should" sound. Every knob is
// pulled from a canonical number:
//
//   height / weight  -> base pitch. Physically the right axis: a 0.3m, 4kg thing
//                       squeaks and a 6.5m, 210kg one does not. From PokeAPI.
//   evolution stage  -> length and note count. A final form gets a longer, more
//                       structured cry, which is also what the games do.
//   primary type     -> contour. Each type maps to one sweep shape, applied
//                       consistently, so two rock types are recognisably kin.
//   legendary        -> a longer, lower, three-part call.
//
// PSRAM WARNING, before this is flashed: main.cpp pre-synthesizes every sound at
// boot into PSRAM. At ~21KB a cry, 151 of them is ~3.1MB, and the board's PSRAM
// size is CONFIG_SPIRAM_TYPE_AUTO so it is not knowable from the config. Do not
// flash 151 pre-synthesized cries. Change synth_tone's caller to synthesize ON
// DEMAND into one reusable buffer instead -- a cry is 21KB of trivial arithmetic
// and precomputing all of them to save microseconds is the wrong trade. Then the
// count stops mattering at all.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const POKEDEX = JSON.parse(readFileSync(new URL("../seed/pokedex.json", import.meta.url), "utf8"));
const RARITY = JSON.parse(readFileSync(new URL("../seed/wild-rarity.json", import.meta.url), "utf8"));
const CRIES_PATH = fileURLToPath(new URL("../seed/species-cries.json", import.meta.url));
const EXISTING = JSON.parse(readFileSync(CRIES_PATH, "utf8"));
const CACHE = fileURLToPath(new URL("../out/pokeapi-cache/", import.meta.url));

const STAGE = new Map(RARITY.species.map((e) => [e.key, e.stage]));
const KEPT = new Map(EXISTING.species.map((s) => [s.key, s]));

mkdirSync(CACHE, { recursive: true });

async function get(url) {
  const file = `${CACHE}${url.replace(/[^a-z0-9]+/gi, "_")}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const body = await res.json();
  writeFileSync(file, JSON.stringify(body));
  return body;
}

// Contour per primary type: a list of (start, end) multipliers applied to the
// base pitch. Deliberately a fixed table rather than anything random -- the point
// is that a type sounds like itself every time.
const CONTOUR = {
  normal:   [[1.00, 1.12]],
  fire:     [[1.00, 1.45], [1.30, 1.05]],
  water:    [[1.05, 0.88], [0.92, 1.10]],
  electric: [[1.00, 1.60], [1.55, 1.60]],
  grass:    [[0.95, 1.15], [1.10, 1.00]],
  ice:      [[1.20, 1.05], [1.08, 1.25]],
  fighting: [[1.00, 0.82], [0.85, 0.78]],
  poison:   [[1.00, 0.90], [0.95, 1.08]],
  ground:   [[0.88, 0.78]],
  flying:   [[1.10, 1.40], [1.35, 1.15]],
  psychic:  [[1.00, 1.25], [1.20, 0.95], [1.05, 1.30]],
  bug:      [[1.15, 1.20], [1.18, 1.15], [1.20, 1.22]],
  rock:     [[0.85, 0.80]],
  ghost:    [[1.05, 0.75], [0.80, 1.00]],
  dragon:   [[0.90, 1.10], [1.05, 0.85]],
  dark:     [[0.95, 0.85]],
  steel:    [[1.00, 1.05], [1.05, 0.98]],
  fairy:    [[1.15, 1.30], [1.28, 1.18]],
};

// Base pitch from physical size. Log-scaled because the range is enormous (0.2m
// to 6.5m, 0.1kg to 460kg) and a linear map would put everything mid-sized in a
// narrow band and make the extremes absurd.
function basePitch(heightDm, weightHg) {
  const metres = Math.max(0.2, heightDm / 10);
  const kg = Math.max(0.1, weightHg / 10);
  const bulk = Math.log10(metres * 10) + Math.log10(kg);   // ~0.3 (tiny) .. ~4.6 (huge)
  const t = Math.min(1, Math.max(0, (bulk - 0.3) / 4.3));
  return Math.round(900 - t * 640);                        // 900Hz squeak .. 260Hz rumble
}

function cryFor(species, height, weight) {
  const pitch = basePitch(height, weight);
  const stage = STAGE.get(species.key) ?? 0;
  const legendary = species.isLegendary || species.isMythical;
  const shape = CONTOUR[species.types[0]] ?? CONTOUR.normal;

  // Later forms get more of the contour and longer notes; a baby or base form
  // gets the opening gesture only.
  const take = legendary ? shape.length : Math.min(shape.length, stage + 1);
  const noteMs = legendary ? 150 : 90 + stage * 30;
  const drop = legendary ? 0.82 : 1;   // legendaries sit lower

  const notes = shape.slice(0, take).map(([from, to], i) => ({
    f0: Math.round(pitch * from * drop),
    f1: Math.round(pitch * to * drop),
    ms: noteMs + (i === take - 1 ? 60 : 0),   // hold the last note
  }));

  // A legendary gets a gap before its final note, which is the whole reason it
  // reads as a call rather than a chirp.
  if (legendary && notes.length > 1) notes.splice(1, 0, { f0: 0, f1: 0, ms: 70 });
  return notes;
}

const dry = process.argv.includes("--dry");

// ORDER IS AN ABI. `cryAudioId` is soundBase + index into this list, and the
// firmware's species_cries.inc is generated from the same order, so reordering it
// silently remaps every sound id -- a host that has not been reflashed in lockstep
// would ask for one species' cry and get another's.
//
// So the existing entries come first, in their existing order, untouched. New ones
// are appended. That also keeps ids 3..20 valid on a device still running the old
// firmware.
//
// This is not hypothetical: the first version of this script iterated the 151-entry
// pokedex instead, which silently DROPPED the five eeveelutions that are not
// Generation 1 (espeon, umbreon, leafeon, glaceon, sylveon) and shifted every id
// after them. The cry list is not the dex and must not be rebuilt from it.
const species = [...EXISTING.species];
const present = new Set(species.map((s) => s.key));
for (const s of POKEDEX.species) {
  if (present.has(s.key)) continue;
  const api = await get(`https://pokeapi.co/api/v2/pokemon/${s.dex}/`);
  species.push({ key: s.key, notes: cryFor(s, api.height, api.weight) });
  present.add(s.key);
}

const out = { soundBase: EXISTING.soundBase, species };
const durations = species.map((s) => s.notes.reduce((t, n) => t + n.ms, 0));
const bytes = durations.reduce((t, ms) => t + Math.floor((16000 * ms) / 1000) * 4, 0);

console.log(`species: ${species.length}  (${KEPT.size} hand-authored, preserved; ${species.length - KEPT.size} generated)`);
console.log(`duration: min ${Math.min(...durations)}ms  mean ${(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(0)}ms  max ${Math.max(...durations)}ms`);
console.log(`pre-synthesized in PSRAM, all of them: ${(bytes / 1024 / 1024).toFixed(2)} MB  <-- see the PSRAM warning at the top`);

if (dry) { console.log("\n--dry: nothing written"); }
else {
  writeFileSync(CRIES_PATH, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\nwrote seed/species-cries.json`);
  console.log("next: node scripts/gen-cries.mjs   (regenerates firmware/main/species_cries.inc)");
}
