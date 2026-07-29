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
const ART = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon";
const DW = `${ART}/other/dream-world`;
// dream-world is SVG, every other set PokeAPI carries is PNG.
function artUrl(name) {
  return ALT_ART[name] ? `${ART}/${ALT_ART[name]}/${SPECIES[name]}.png` : `${DW}/${SPECIES[name]}.svg`;
}
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

// Render at 4x and box-filter down: the SVGs are flat-shaded vector art, and
// supersampling is what turns a hard vector edge into the few grey levels the
// thresholding below has to work with.
async function renderGray(svgText, targetMax) {
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

  return { gray: rgbaToGray(g.getImageData(0, 0, w, h).data, w * h), w, h };
}

// One-pixel dilation was tried here on 2026-07-29 to put weight back into
// strokes thinned by a lowered threshold, and REJECTED on review: it closed up
// the fine detail on zubat, venomoth and kabutops. It was also applied far too
// broadly -- to all 41 species with a lowered threshold rather than the six
// actually reported as washed out. Do not reintroduce it without a per-species
// list that someone has looked at. dilate1bpp still exists in the render layer
// for its original purpose.
// Half-weight stroke. Grows ink right and down only, so a 1px stroke becomes
// 2px rather than the 3px a symmetric dilation gives, and a gap closes only if
// it was 1px wide AND on the growth side. This is the faux-bold trick (offset a
// copy and overlay), not a morphological dilation -- which matters, because the
// symmetric version was tried on 2026-07-29 and rejected for closing up the
// fine detail on zubat, venomoth and kabutops.
function dilateHalf(mask, w, h) {
  const out = Uint8Array.from(mask);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (mask[y * w + x] !== 0) continue;
      if (x + 1 < w) out[y * w + x + 1] = 0;
      if (y + 1 < h) out[(y + 1) * w + x] = 0;
    }
  }
  return out;
}

function grayToMask(gray, threshold) {
  const mask = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) mask[i] = gray[i] < threshold ? 0 : 255;
  return mask;
}

// Paint a filled disc of ink. This is the one place the bake draws something
// the artwork does not contain, and it exists for exactly one problem: a few
// species are drawn with an eye ring and no darker pupil inside it, so the eye
// thresholds to an empty circle and the sprite looks blind. See PUPILS.
function stampDot(mask, w, h, cx, cy, r) {
  if (cx < 0 || cy < 0 || cx >= w || cy >= h) {
    throw new Error(`pupil (${cx},${cy}) is outside the ${w}x${h} sprite -- re-measure it`);
  }
  for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y += 1) {
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) mask[y * w + x] = 0;
    }
  }
  return mask;
}

function finish(mask, w, h, { bold = false, pupils = [], strokes = [] } = {}) {
  // Bold first: dilating a stamped dot or a redrawn 1px edge would defeat the
  // point of choosing that size.
  const out = bold ? dilateHalf(mask, w, h) : mask;
  for (const [cx, cy, r] of pupils) stampDot(out, w, h, cx, cy, r);
  for (const [x0, y0, x1, y1] of strokes) stampLine(out, w, h, x0, y0, x1, y1);
  return out;
}

export async function bakeDW(svgText, targetMax = 155, boost = 25, maxInkRatio = 0.30, opts = {}) {
  const { gray, w, h } = await renderGray(svgText, targetMax);
  const threshold = calibratedThreshold(gray, 0.13, boost, maxInkRatio);
  return oneBitTransparentPng(finish(grayToMask(gray, threshold), w, h, opts), w, h, 128);
}

// Ink an explicit set of luminance bands instead of everything below one
// threshold. Only gastly uses this -- see BANDS. Cuts here are ABSOLUTE grey
// levels, not offsets from the calibrated threshold, because the whole point is
// to separate three flat fills whose values were measured; a calibrated
// threshold is one number by construction and cannot express "ink this band and
// not the darker one next to it".
export async function bakeDWBands(svgText, targetMax = 155, bands = [], opts = {}) {
  const { gray, w, h } = await renderGray(svgText, targetMax);
  // oneBitTransparentPng inks "below threshold", so build a 0/255 mask and hand
  // it a threshold of 128 rather than teaching it a second convention.
  const mask = new Uint8Array(gray.length).fill(255);
  for (let i = 0; i < gray.length; i += 1) {
    for (const [lo, hi] of bands) {
      if (gray[i] >= lo && gray[i] < hi) { mask[i] = 0; break; }
    }
  }
  return oneBitTransparentPng(finish(mask, w, h, opts), w, h, 128);
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
//
// 2026-07-29, second and third hardware review: 35 more came back as filled
// silhouettes. Same cause as slowpoke above -- a mid-tone body fill sits below
// the calibrated threshold, so the linework that should define the shape is
// swallowed by it. The values below were picked by sweeping each species and
// looking at the result (out/boost-sweep.mjs), not by reasoning about the art:
// the ladder is not monotonic in usefulness, because past a point the outlines
// themselves start to break into dashes. Most land at 0 or -10; alakazam needs
// -20 and marowak -30 before a shadow band finally clears, and bellsprout is a
// compromise at -20 (the bell goes white there, and its stalk stays solid at
// every setting that leaves the leaves intact).
//
// Going lower is not free. dratini at -30 on the dream-world art came back as a
// featureless white noodle: every trace of the tonal difference between its body
// and its underside was gone. "The blob cleared" is not the same as "the sprite
// is right". It ended up on official-artwork instead (see ALT_ART), where -30
// keeps the shading it needs.
const BOOST = {
  flareon: 6, umbreon: -15, eevee: 6, charmander: -12,
  slowpoke: -10, voltorb: -10, ditto: -10,
  // Body filling in as a solid blob -> white body, black linework.
  zubat: 0, arcanine: 0, kadabra: 0, farfetchd: 0, dodrio: 0,
  ivysaur: 0, beedrill: 0, venomoth: 0, machamp: 0, cubone: 0,
  hitmonlee: -10, doduo: -10, seaking: -10, staryu: -10, scyther: -10,
  pinsir: -10, magikarp: -10, lapras: -10, omastar: -10, kabutops: -10,
  dragonair: -10, raticate: -10, pidgeotto: -10, spearow: -10, mankey: -10,
  primeape: -10, koffing: -10, ekans: -10, poliwrath: -10,
  nidoking: 0, victreebel: 0, pikachu: 0, raichu: 0,
  geodude: 0, graveler: 0, krabby: 0, porygon: 0,
  poliwag: 10, golduck: -10, kingler: -10, butterfree: 15, weepinbell: -30,
  diglett: -15, dugtrio: -15, persian: -15,
  bellsprout: -20, alakazam: -20, tentacool: -20, marowak: -30,
  magmar: 10,
  // Replacement artwork (see ALT_ART): painted rather than flat vector, so it
  // needs a lower cut than the dream-world sprites to stay a line drawing.
  vulpix: 0, pidgey: -20, rattata: -15, dratini: -30,
  // The one that needed MORE ink, not less: shellder's pupils are small dark
  // dots inside already-dark eyes, and below +45 they threshold away entirely
  // and it stares blankly.
  shellder: 80,
};

// Gastly is the only species one threshold cannot serve, and it gets its own
// path rather than a fudged BOOST. Owner's call: the gas should be black and
// the head should NOT be a solid disc. The gas is *lighter* than the head, so
// every threshold that reaches the gas has already filled the head in -- the
// two requirements are contradictory for a single cut, which is why earlier
// attempts could only trade one for the other.
//
// Measured levels in the rendered grey (out/gastly-bands.mjs): 48 = linework,
// 68/74 = head fill, 87 = gas, 255 = paper and the eye whites. Inking the
// darkest band and the gas band while leaving the head fill white gives a white
// head with line-art eyes and grin inside a solid cloud.
//
// These cuts are absolute and therefore tied to this specific artwork. If
// PokeAPI ever reworks the dream-world gastly they stop meaning anything -- the
// ink window in test/sprites.test.js is what will catch that.
//
// parasect is the same shape of problem as gastly, from the other direction:
// its cap spots are LIGHTER than the cap, so a single cut gives either a black
// cap with white spots (recognisable, but the blob the owner rejected) or a
// white cap with no spots at all. Measured levels: 15-21 linework, 70-72 cap,
// 134-157 body and claws, 181 the spots. Inking the linework and the spot band
// gives a white cap with black spots.
const BANDS = {
  gastly: [[0, 58], [80, 100]],
  parasect: [[0, 40], [170, 190]],
  // Same trick for a missing pupil: jigglypuff's pupils are their own level at
  // 137-140, LIGHTER than the linework and lost by any single cut that keeps the
  // body white. Inking linework plus that one band puts the eyes back.
  // butterfree was tried this way too and ended up on a plain threshold with a
  // stamped pupil instead -- see PUPILS.
  jigglypuff: [[0, 50], [130, 150]],
};

// A few dream-world sprites are simply the wrong picture for this panel, and no
// threshold fixes a marking that is not in the source. out/alt-art.mjs renders
// a species across every set PokeAPI carries so the replacement is chosen by
// looking. Why each one moved:
//   weepinbell  dream-world has no body spots at all; official-artwork does
//   vulpix      dream-world's eye is an empty ring at every threshold from +100
//               down -- there is no darker pupil tone in the file
//   pidgey      dream-world has no linework layer at all, just two flat fills
//               (grey 65-76 plumage, 222-228 body), so every cut gives either
//               colour blocks or dotted noise -- never an outline
//   rattata     its dream-world art is gradient-shaded, not flat (one band
//               spanning grey 67-105), so its front teeth never resolve at any
//               threshold; the official-artwork pose has the mouth open
// The painted sets (official-artwork) carry gradients rather than flat vector,
// so they also need a lower BOOST -- see above.
//
// blastoise was moved here to the gen-5 game sprite and then moved BACK: the
// owner rejected pixel art next to 150 illustrations. It stays on dream-world
// at the default. No illustration set does better -- official-artwork gives a
// solid black shell at any usable threshold and noise below that -- so treat
// "blastoise looks mediocre" as known and not worth re-litigating without a
// new idea.
// Half-weight stroke, approved on review 2026-07-29 for exactly these species
// and no others. The symmetric version was rejected; see dilateHalf. Keep this
// list to sprites somebody has actually looked at both ways -- the mistake last
// time was applying a stroke change to everything that had been retuned.
const HALF_BOLD = new Set([
  "pidgeotto", "parasect", "primeape", "alakazam", "marowak", "mr-mime",
  "pinsir", "magikarp", "lapras", "omastar", "kabuto",
  "golduck", "raticate", "spearow",
]);

// Hand-placed pupils, in baked-sprite pixel coordinates as [x, y, radius].
//
// magikarp and butterfree are drawn with an eye ring and nothing darker inside
// it, so no threshold and no band can produce a pupil -- out/bands.mjs shows
// the levels simply are not there. Rather than move them onto artwork the owner
// liked less, the bake stamps the dot. Owner asked for this explicitly.
//
// These coordinates are tied to the 155px bake and to the current source file.
// stampDot throws if one lands outside the sprite, but it CANNOT tell that a
// reworked upstream drawing moved the eye somewhere else -- so if either sprite
// is ever re-sourced, re-measure with out/eye-finder.mjs rather than assuming.
// Measured, not eyeballed -- the first pair of these was read off a zoomed
// screenshot and landed low and right of both eyes, and too large. magikarp's
// comes from out/eye-measure.mjs, which finds the enclosed hole the eye ring
// makes. butterfree's ring is not closed so that will not find it; its two
// compound eyes were located instead by detecting the pink fill in the source
// artwork at bake scale, which is the only way to see that the far eye exists
// at all -- at 1-bit it is a narrow sliver.
const PUPILS = {
  magikarp: [[35, 61, 1]],                  // eye hole x 26-44, y 52-71
  koffing: [[44, 57, 1], [71, 58, 1]],      // white squint-crescents, 10x6 and 17x7
  kingler: [[62, 111, 1], [89, 111, 1]],    // white eye ovals, 14x9 and 15x10
};

// Redrawn linework, [x0, y0, x1, y1], 1px to match the strokes it patches.
// Same category as PUPILS -- the bake drawing what the threshold could not --
// and held to the same rule: measured from the source artwork, never eyeballed.
// rattata's incisor has no left or top edge at its threshold, so the tooth runs
// into the muzzle as one white area. The white tooth fill measures x 29-38,
// y 88-101 in the source, which is where these two edges come from.
const STROKES = {
  rattata: [[29, 85, 29, 100], [29, 85, 37, 85]],
};

// Bresenham. Only ever used for STROKES.
function stampLine(mask, w, h, x0, y0, x1, y1) {
  for (const [x, y] of [[x0, y0], [x1, y1]]) {
    if (x < 0 || y < 0 || x >= w || y >= h) {
      throw new Error(`stroke endpoint (${x},${y}) is outside the ${w}x${h} sprite -- re-measure it`);
    }
  }
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    mask[y * w + x] = 0;
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

const ALT_ART = {
  weepinbell: "other/official-artwork",
  vulpix: "other/official-artwork",
  pidgey: "other/official-artwork",
  rattata: "other/official-artwork",
  dratini: "other/official-artwork",
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
    // bakeDW only does Buffer.from(source) + loadImage, so a raster set can be
    // handed straight in as bytes; only the flat-vector dream-world set is text.
    const bytes = await fetchBytes(artUrl(name));
    const source = ALT_ART[name] ? bytes : bytes.toString("utf8");
    const opts = { bold: HALF_BOLD.has(name), pupils: PUPILS[name] ?? [], strokes: STROKES[name] ?? [] };
    const png = BANDS[name]
      ? await bakeDWBands(source, 155, BANDS[name], opts)
      : await bakeDW(source, 155, BOOST[name] ?? 25, 0.30, opts);
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
