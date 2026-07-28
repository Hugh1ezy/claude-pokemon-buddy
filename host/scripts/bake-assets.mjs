// Reproducible bake for every buddy sprite + the Oak portrait.
// Run from host/: node scripts/bake-assets.mjs   (optionally: ... bulbasaur pikachu)
//
// The species list comes from seed/pokedex.json (scripts/gen-pokedex.mjs), so
// "which sprites exist" has one source of truth rather than a second list to
// keep in step. Pass species keys as arguments to re-bake just those -- useful
// when tuning BOOST for one that came out too dark, which otherwise means
// re-downloading 151 SVGs to change one number.
//
// What this writes is NOT committed -- it is Nintendo/Game Freak artwork and
// this repository is public. seed/sprites/ and seed/oak.png are gitignored, so
// a fresh checkout has no sprites until this has been run once (see
// SETUP-WINDOWS.md). The sprite tests skip themselves rather than fail when
// that has not happened yet, so "I have not baked yet" never looks like "the
// renderer is broken".
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const SEED = fileURLToPath(new URL("../seed/", import.meta.url));
const SPRITES = fileURLToPath(new URL("../seed/sprites/", import.meta.url));
const DW = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/dream-world";
const OAK = "https://archives.bulbagarden.net/media/upload/4/4c/Spr_FRLG_Oak.png";
const POKEDEX = JSON.parse(readFileSync(new URL("../seed/pokedex.json", import.meta.url), "utf8"));

// Five later-generation Eeveelutions predate the gen-1 dex and are still
// reachable through seed/evolution/eevee.json, so their sprites still have to
// exist -- but they are NOT dex entries: the pokedex screen counts to 151 and
// they are not among them. Kept in a separate list precisely so that stays
// obvious, and so retiring them later is a one-line deletion here rather than
// an archaeology exercise.
const LEGACY_NON_DEX = { espeon: 196, umbreon: 197, leafeon: 470, glaceon: 471, sylveon: 700 };
const SPECIES = {
  ...Object.fromEntries(POKEDEX.species.map((s) => [s.key, s.dex])),
  ...LEGACY_NON_DEX,
};

export async function fetchBytes(url) {
  const res = await fetch(url, { headers: { "user-agent": "claude-pokemon-buddy asset baker" } });
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function bakeDW(svgText, targetMax = 155, boost = 25, maxInkRatio = 0.30) {
  const image = await loadImage(Buffer.from(svgText));
  const scale = (targetMax * 4) / Math.max(image.width, image.height);
  const hiW = Math.max(1, Math.round(image.width * scale));
  const hiH = Math.max(1, Math.round(image.height * scale));
  const w = Math.max(1, Math.round(hiW / 4));
  const h = Math.max(1, Math.round(hiH / 4));

  const hi = createCanvas(hiW, hiH);
  const hg = hi.getContext("2d");
  hg.fillStyle = "#fff";
  hg.fillRect(0, 0, hiW, hiH);
  hg.imageSmoothingEnabled = true;
  hg.imageSmoothingQuality = "high";
  hg.drawImage(image, 0, 0, hiW, hiH);

  const canvas = createCanvas(w, h);
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(hi, 0, 0, w, h);

  const data = g.getImageData(0, 0, w, h).data;
  const gray = rgbaToGray(data, w * h);
  const threshold = calibratedThreshold(gray, 0.13, boost, maxInkRatio);
  return oneBitTransparentPng(gray, w, h, threshold);
}

async function bakeOak(pngBuffer, threshold = 175) {
  const image = await loadImage(pngBuffer);
  const canvas = createCanvas(image.width, image.height);
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, image.width, image.height);
  g.imageSmoothingEnabled = false;
  g.drawImage(image, 0, 0);

  const data = g.getImageData(0, 0, image.width, image.height).data;
  const gray = rgbaToGray(data, image.width * image.height);
  const mask = new Uint8Array(gray.length);
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const i = y * image.width + x;
      if (gray[i] < threshold) {
        mask[i] = 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < minX || maxY < minY) throw new Error("Oak bake produced no ink");
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const cropped = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const src = (minY + y) * image.width + minX + x;
      if (mask[src]) cropped[y * w + x] = 0;
    }
  }

  return oneBitTransparentPng(cropped, w, h, 128);
}

function rgbaToGray(data, pixels) {
  const gray = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const offset = i * 4;
    gray[i] = (data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114) | 0;
  }
  return gray;
}

// targetInkRatio: minimum ink (finds base threshold). boost: keep thin strokes solid.
// maxInkRatio: hard cap — back the threshold off toward base so a large flat fill can't turn the
// whole body into a solid blob (which erases interior detail like eyes on a dark-bodied sprite).
function calibratedThreshold(gray, targetInkRatio, boost, maxInkRatio = 1) {
  let base = 128;
  for (let t = 0; t <= 255; t += 1) {
    let ink = 0;
    for (const value of gray) if (value < t) ink += 1;
    if (ink / gray.length >= targetInkRatio) { base = t; break; }
  }
  let threshold = Math.max(0, Math.min(255, base + boost));
  const inkAt = (t) => { let n = 0; for (const v of gray) if (v < t) n += 1; return n / gray.length; };
  while (threshold > base && inkAt(threshold) > maxInkRatio) threshold -= 1;
  return threshold;
}

async function oneBitTransparentPng(gray, w, h, threshold) {
  const canvas = createCanvas(w, h);
  const g = canvas.getContext("2d");
  const image = g.createImageData(w, h);
  for (let i = 0; i < gray.length; i += 1) {
    const off = i * 4;
    const ink = gray[i] < threshold;
    image.data[off] = ink ? 0 : 255;
    image.data[off + 1] = ink ? 0 : 255;
    image.data[off + 2] = ink ? 0 : 255;
    image.data[off + 3] = ink ? 255 : 0;
  }
  g.putImageData(image, 0, 0);
  return canvas.encode("png");
}

// Per-species ink tuning approved from hardware review. Everything else takes
// the default; this list only grows when a sprite is looked at on the panel
// and judged wrong, never pre-emptively.
// slowpoke/voltorb/ditto are near-solid flat bodies: at the default the
// calibrated threshold swallows the whole silhouette (ink 0.44/0.55/0.66 --
// a black blob with no eyes) and maxInkRatio cannot rescue it, because it only
// backs off as far as the base threshold and the base is already past the
// cliff. Measured across the range, ink falls off sharply between 0 and -10
// (0.44 -> 0.117, 0.55 -> 0.101, 0.66 -> 0.099) and then only erodes detail --
// voltorb is an empty image by -70. -10 is the first value on the good side.
const BOOST = {
  flareon: 6, umbreon: -15, eevee: 6, charmander: -12,
  slowpoke: -10, voltorb: -10, ditto: -10,
};

// Guarded so bakeDW/fetchBytes can be imported (BOOST tuning wants to re-bake
// one sprite at a dozen different settings without hitting the CDN each time).
// Importing this file used to start a 151-sprite download as a side effect.
const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) await main();

async function main() {
const only = process.argv.slice(2);
const unknown = only.filter((name) => !(name in SPECIES));
if (unknown.length > 0) throw new Error(`unknown species: ${unknown.join(", ")}`);
const wanted = only.length > 0 ? only : Object.keys(SPECIES);

mkdirSync(SPRITES, { recursive: true });
// Sequential on purpose. This is a rarely-run generator hitting someone else's
// free CDN with 151 requests; the whole bake is a couple of minutes and being
// a good citizen matters more than finishing sooner.
const failed = [];
for (const name of wanted) {
  try {
    const svg = (await fetchBytes(`${DW}/${SPECIES[name]}.svg`)).toString("utf8");
    const png = await bakeDW(svg, 155, BOOST[name] ?? 25, 0.30);
    writeFileSync(`${SPRITES}/${name}.png`, png);
    console.log(`wrote seed/sprites/${name}.png`);
  } catch (error) {
    // One bad sprite must not cost the other 150 downloads. Collected and
    // re-reported at the end, where it cannot scroll past unnoticed.
    failed.push(`${name}: ${error.message}`);
    console.warn(`FAILED ${name}: ${error.message}`);
  }
}

if (only.length === 0) {
  const oak = await bakeOak(await fetchBytes(OAK));
  writeFileSync(`${SEED}/oak.png`, oak);
  console.log("wrote seed/oak.png");
}

if (failed.length > 0) {
  console.error(`\n${failed.length} sprite(s) failed:\n  ${failed.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log(`\nbaked ${wanted.length} sprite(s)`);
}
}
