#!/usr/bin/env node
// Fetches the real Game Boy cries and bakes them into the raw PCM the device
// plays off its SD card.
//
//   cd host && node scripts/bake-cries.mjs              # bake all 138
//   cd host && node scripts/bake-cries.mjs --wav 25 26  # also write WAVs to audition
//   cd host && node scripts/bake-cries.mjs --limit 6    # first 6 only, for a listen
//
// Output: seed/cries/<soundId>.raw  — 16 kHz mono signed 16-bit LE, headerless.
//
// ## This is Nintendo audio and it does not go in the repo
//
// Same rule and same reason as `seed/sprites/` and `seed/oak.png`, which
// `bake-assets.mjs` fetches and `.gitignore` keeps out: the fork is public.
// `seed/cries/` is gitignored. A fresh checkout runs this script once, exactly
// as it runs the asset baker.
//
// ## Why `legacy` and not `latest`
//
// PokeAPI carries both. Despite the extension, `latest/*.ogg` is an MP3 of the
// modern remastered cry; `legacy/*.ogg` is real Ogg Vorbis of the Game Boy
// original. This device is a 1-bit reflective panel showing Gen-1 species, and
// the remastered cries sound imported from a different product on it.
//
// ## Which 138
//
// The first 18 entries of `seed/species-cries.json` were authored by hand -- the
// eeveelutions and the three starter lines -- and the owner asked on 2026-08-03
// for those to stay as they are. Everything after index 18 is generated from
// height/weight/type, and those are what gets a real recording. The split is
// read from the file's own order rather than hardcoded, because that order is an
// ABI (`cryAudioId` = `soundBase + index`) and duplicating it here is how the two
// would drift.
//
// Skipping a species is therefore a *data* decision, not a code one: the device
// falls back to its synthesized cry for any id with no file on the card, so the
// 18 stay synthesized simply by never being baked or pushed.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { OggVorbisDecoder } from "@wasm-audio-decoders/ogg-vorbis";

const CRIES = "https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/legacy";
const OUT_DIR = "seed/cries";
const TARGET_SR = 16000;          // AUDIO_SR in firmware/main/main.cpp
const HAND_WRITTEN = 18;          // entries before this index are the owner's, untouched

const args = process.argv.slice(2);
const wantWav = args.includes("--wav");
const wavIds = new Set(args.slice(args.indexOf("--wav") + 1).filter((a) => /^\d+$/.test(a)).map(Number));
const limitAt = args.indexOf("--limit");
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;

const cries = JSON.parse(readFileSync("seed/species-cries.json", "utf8"));
const dexRaw = JSON.parse(readFileSync("seed/pokedex.json", "utf8"));
const dexList = Array.isArray(dexRaw) ? dexRaw : (dexRaw.species ?? Object.values(dexRaw));
// The field is `dex`. Mapped explicitly rather than with a chain of fallbacks:
// a `??` ladder over guessed field names silently yields undefined for every
// entry when none of them is right, which reads as "this species has no dex
// number" 138 times over instead of "I am reading the wrong field".
const dexNumber = new Map(dexList.filter((e) => e?.key && e.dex).map((e) => [e.key, e.dex]));
if (dexNumber.size === 0) throw new Error("no dex numbers parsed out of seed/pokedex.json");

mkdirSync(OUT_DIR, { recursive: true });

const targets = cries.species
  .map((entry, index) => ({ ...entry, soundId: cries.soundBase + index, index }))
  .filter((entry) => entry.index >= HAND_WRITTEN)
  .slice(0, limit);

console.log(`baking ${targets.length} cries -> ${OUT_DIR}/ (16 kHz mono s16le)`);

const decoder = new OggVorbisDecoder();
await decoder.ready;

let done = 0, skipped = 0, failed = 0;
let shortest = Infinity, longest = 0, totalBytes = 0;
const audition = [];

for (const entry of targets) {
  const dex = dexNumber.get(entry.key);
  if (!dex) { console.log(`  skip ${entry.soundId}: no national dex number`); skipped++; continue; }

  const outPath = join(OUT_DIR, `${entry.soundId}.raw`);
  try {
    const res = await fetch(`${CRIES}/${dex}.ogg`, {
      headers: { "user-agent": "claude-pokemon-buddy cry baker" },
    });
    if (!res.ok) { console.log(`  FAIL ${entry.soundId}: HTTP ${res.status}`); failed++; continue; }

    const ogg = new Uint8Array(await res.arrayBuffer());
    const { channelData, sampleRate } = await decoder.decodeFile(ogg);
    decoder.reset();

    const mono = toMono(channelData);
    const resampled = resampleLinear(mono, sampleRate, TARGET_SR);
    const pcm = toInt16(normalise(trimSilence(resampled)));

    writeFileSync(outPath, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    const ms = Math.round((pcm.length / TARGET_SR) * 1000);
    if (wantWav && (wavIds.size === 0 || wavIds.has(entry.soundId))) {
      writeFileSync(join(OUT_DIR, `${entry.soundId}.wav`), wavFile(pcm, TARGET_SR));
      audition.push({ soundId: entry.soundId, dex, zh: entry.zh ?? entry.key, ms });
    }

    shortest = Math.min(shortest, ms);
    longest = Math.max(longest, ms);
    totalBytes += pcm.byteLength;
    done++;
  } catch (error) {
    console.log(`  FAIL ${entry.soundId}: ${error.message}`);
    failed++;
  }
}

decoder.free();

if (wantWav && audition.length) {
  writeFileSync(join(OUT_DIR, "audition.html"), auditionPage(audition));
  console.log(`audition: ${OUT_DIR}/audition.html (${audition.length} cries) -- open it in a browser`);
}

// Counts and aggregates only -- this output is read by the owner, and which
// species sounds like what is his to discover (CLAUDE.md).
console.log(`baked ${done}, skipped ${skipped}, failed ${failed}`);
if (done) {
  console.log(`length  : ${shortest}..${longest} ms`);
  console.log(`on card : ${(totalBytes / 1024 / 1024).toFixed(2)} MB total, ${Math.round(totalBytes / done / 1024)} KB average`);
  console.log(`longest : ${Math.round((longest / 1000) * TARGET_SR * 2 / 1024)} KB -- the device streams these, so this does not size any buffer`);
}

function toMono(channelData) {
  if (channelData.length === 1) return channelData[0];
  const [l, r] = channelData;
  const out = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) out[i] = (l[i] + r[i]) / 2;
  return out;
}

// Linear interpolation is enough here and deliberately so: the source is a
// ~5 kHz-bandwidth Game Boy sample and the target is a small mono speaker, so
// the resampler is nowhere near the weakest link in the chain.
function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const a = Math.floor(pos);
    const frac = pos - a;
    out[i] = (input[a] ?? 0) * (1 - frac) + (input[a + 1] ?? input[a] ?? 0) * frac;
  }
  return out;
}

// The originals carry leading and trailing near-silence of varying length. A cry
// fires on an encounter and on every KEY press, so a fixed 80 ms of dead air
// before the sound reads as lag rather than as part of the sound.
function trimSilence(samples, floor = 0.005) {
  let start = 0, end = samples.length - 1;
  while (start < samples.length && Math.abs(samples[start]) < floor) start++;
  while (end > start && Math.abs(samples[end]) < floor) end--;
  return start >= end ? samples : samples.subarray(start, end + 1);
}

// Peak-normalise to -1 dBFS. The device's own volume control is the thing the
// owner turns; cries arriving at wildly different levels would make that control
// useless, and the source recordings are not level-matched to each other.
function normalise(samples, ceiling = 0.891) {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  if (peak === 0) return samples;
  const gain = ceiling / peak;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

function toInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

// A local page, opened over file://, never published. It plays the WAVs sitting
// next to it -- which are Nintendo audio, so this must not become an artifact,
// a gist, or anything with a URL.
//
// It exists because the owner reviews in batches and will point at specific
// items given a labelled grid; asking him to open 138 files one at a time and
// remember which were wrong is how a review turns into a chore and stops
// happening. Ticking the bad ones produces a plain list of ids to paste back.
function auditionPage(rows) {
  const cards = rows.map((r) => `
    <label class="card" data-id="${r.soundId}">
      <input type="checkbox" class="bad">
      <span class="id">#${r.soundId}</span>
      <span class="zh">${escapeHtml(r.zh)}</span>
      <span class="meta">dex ${r.dex} · ${r.ms} ms</span>
      <audio controls preload="none" src="${r.soundId}.wav"></audio>
    </label>`).join("");

  return `<!doctype html>
<meta charset="utf-8">
<title>叫声试听 · ${rows.length} 条</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.note { opacity: .7; margin: 0 0 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
  .card { display: grid; grid-template-columns: auto auto 1fr; gap: 4px 8px;
          align-items: center; border: 1px solid currentColor; border-radius: 8px;
          padding: 8px 10px; opacity: .85; }
  .card:has(.bad:checked) { outline: 2px solid crimson; opacity: 1; }
  .id { font-variant-numeric: tabular-nums; opacity: .6; }
  .zh { font-weight: 600; }
  .meta { grid-column: 2 / -1; font-size: 12px; opacity: .6; }
  audio { grid-column: 1 / -1; width: 100%; height: 32px; }
  #out { position: sticky; bottom: 0; padding: 12px; margin-top: 16px;
         border-top: 1px solid currentColor; background: Canvas; }
  textarea { width: 100%; height: 3em; font: 13px monospace; }
</style>
<h1>叫声试听 — ${rows.length} 条真实 GB 录音</h1>
<p class="note">听着不对的打勾，页面底部会生成 id 列表，直接复制回聊天即可。手写的 18 条不在这里。</p>
<div class="grid">${cards}</div>
<div id="out">
  <button id="copy">生成 id 列表</button>
  <textarea id="ids" readonly placeholder="勾选后点上面的按钮"></textarea>
</div>
<script>
  document.getElementById("copy").addEventListener("click", () => {
    const ids = [...document.querySelectorAll(".card")]
      .filter((c) => c.querySelector(".bad").checked)
      .map((c) => c.dataset.id);
    document.getElementById("ids").value = ids.length ? ids.join(", ") : "(没有勾选)";
    document.getElementById("ids").select();
  });
  // One at a time: overlapping cries make every one of them sound wrong.
  document.addEventListener("play", (e) => {
    for (const a of document.querySelectorAll("audio")) if (a !== e.target) a.pause();
  }, true);
</script>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function wavFile(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}
