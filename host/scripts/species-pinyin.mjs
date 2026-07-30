// Chinese name -> ASCII pinyin, for naming audio files.
//
//   cd host && node scripts/species-pinyin.mjs          # print the list
//   cd host && node scripts/species-pinyin.mjs --check   # collisions only
//
// The owner's rule, 2026-07-30: every audio file is named after the pokemon's
// Chinese name in pinyin, because an English key like `ivysaur` does not tell him
// whose sound he is looking at.
//
// Readings come from mozillazg/pinyin-data (a packaging of Unicode's Unihan
// kMandarin), cached at out/pinyin-data.txt. Not hand-written: 151 names is ~250
// distinct characters and hand-mapping them would put quiet errors in the one
// thing whose entire job is telling two files apart.
//
// KNOWN LIMIT: a polyphonic character gets its FIRST listed reading, which is the
// most common one but not always the right one in a name. Collisions are reported
// rather than silently suffixed, so a wrong one shows up as two files that cannot
// be told apart -- which is exactly the failure the owner is trying to avoid.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DATA = fileURLToPath(new URL("../out/pinyin-data.txt", import.meta.url));
const SOURCE = "https://raw.githubusercontent.com/mozillazg/pinyin-data/master/pinyin.txt";

let READINGS = null;

export async function loadReadings() {
  if (READINGS) return READINGS;
  let text;
  if (existsSync(DATA)) text = readFileSync(DATA, "utf8");
  else {
    const res = await fetch(SOURCE);
    if (!res.ok) throw new Error(`pinyin data: HTTP ${res.status}`);
    text = await res.text();
    writeFileSync(DATA, text);
  }
  READINGS = new Map();
  for (const line of text.split(/\r?\n/)) {
    // U+4E2D: zhōng,zhòng  # 中
    const m = /^U\+([0-9A-F]+):\s*([^#]+)/.exec(line);
    if (!m) continue;
    const char = String.fromCodePoint(parseInt(m[1], 16));
    const first = m[2].trim().split(",")[0].trim();
    if (first) READINGS.set(char, first);
  }
  return READINGS;
}

// Tone marks are combining diacritics after NFD, so stripping them is a category
// filter rather than a lookup table. `ü` survives that (it is a letter, not an
// accent) and becomes `v`, the standard ASCII stand-in -- `u` would collide lü
// with lu, which is the one thing this must not do.
export function toAscii(reading) {
  return reading
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ü/g, "v")
    .replace(/[^a-zA-Z]/g, "")
    .toLowerCase();
}

export function pinyinOf(zh, readings) {
  if (typeof zh !== "string" || zh.length === 0) return null;
  let out = "";
  for (const char of zh) {
    const reading = readings.get(char);
    if (reading) { out += toAscii(reading); continue; }
    // Not every character in a Chinese pokemon name IS Chinese: 3D龙 (porygon)
    // starts with two ASCII characters, and rejecting the whole name over them
    // threw away the one file the owner would least be able to identify. Latin
    // letters and digits pass through; anything else genuinely unmappable still
    // fails the name rather than being guessed at.
    if (/[a-zA-Z0-9]/.test(char)) { out += char.toLowerCase(); continue; }
    return null;
  }
  return out || null;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const readings = await loadReadings();
  const cries = JSON.parse(readFileSync(fileURLToPath(new URL("../seed/species-cries.json", import.meta.url)), "utf8"));
  const dex = JSON.parse(readFileSync(fileURLToPath(new URL("../seed/pokedex.json", import.meta.url)), "utf8"));
  const zhOf = new Map(dex.species.map((s) => [s.key, s.zh]));

  const rows = cries.species.map((s, i) => {
    const zh = s.zh ?? zhOf.get(s.key) ?? null;
    return { id: cries.soundBase + i, key: s.key, zh, pinyin: zh ? pinyinOf(zh, readings) : null };
  });

  const seen = new Map();
  for (const r of rows) {
    if (!r.pinyin) continue;
    if (!seen.has(r.pinyin)) seen.set(r.pinyin, []);
    seen.get(r.pinyin).push(r);
  }
  const collisions = [...seen.values()].filter((g) => g.length > 1);
  const unmapped = rows.filter((r) => !r.pinyin);

  if (!process.argv.includes("--check")) {
    for (const r of rows) {
      console.log(`${String(r.id).padStart(3)}  ${(r.pinyin ?? "(NO PINYIN)").padEnd(22)} ${(r.zh ?? "-").padEnd(7)} ${r.key}`);
    }
    console.log("");
  }
  console.log(`${rows.length} sounds, ${rows.length - unmapped.length} named`);
  if (unmapped.length) console.log(`NO CHINESE NAME (${unmapped.length}): ${unmapped.map((r) => r.key).join(", ")}`);
  if (collisions.length) {
    console.log(`COLLISIONS (${collisions.length}) -- these cannot be told apart by filename:`);
    for (const g of collisions) console.log(`  ${g[0].pinyin}: ${g.map((r) => `${r.zh}/${r.key}`).join("  ")}`);
  } else console.log("no collisions: every name is unique");
}
