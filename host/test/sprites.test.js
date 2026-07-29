import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";

import { ditherSpriteGray, loadBuddySprite, loadSpriteGray } from "../src/render/sprites.js";
import { SPECIES_ORDER } from "../src/pet/species-meta.js";

test("loadSpriteGray converts PNG to 96x96 grayscale", async (t) => {
  const dir = join("out", "test-sprites");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spritePath = join(dir, "sprite.png");
  const canvas = createCanvas(4, 4);
  const g = canvas.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, 4, 4);
  writeFileSync(spritePath, await canvas.encode("png"));

  const sprite = await loadSpriteGray(spritePath);

  assert.equal(sprite.w, 96);
  assert.equal(sprite.h, 96);
  assert.equal(sprite.placeholder, false);
  assert.equal(sprite.gray.length, 96 * 96);
  assert.ok(sprite.gray.every((v) => v < 10));
});

test("loadSpriteGray returns checkerboard placeholder when PNG is missing", async () => {
  const sprite = await loadSpriteGray(join("out", "test-sprites", "missing-eevee.png"));

  assert.equal(sprite.w, 96);
  assert.equal(sprite.h, 96);
  assert.equal(sprite.placeholder, true);
  assert.equal(sprite.gray.length, 96 * 96);
  assert.ok(sprite.gray.some((v) => v === 0));
  assert.ok(sprite.gray.some((v) => v === 255));
});

test("loadBuddySprite loads the real Eevee asset", async () => {
  const sprite = await loadBuddySprite("eevee");

  assert.equal(sprite.placeholder, false);
  assert.ok(sprite.w > 20 && sprite.h > 30);
  assert.equal(sprite.gray.length, sprite.w * sprite.h);
});

test("loadOakSprite loads the committed Oak asset", async () => {
  const { loadOakSprite } = await import("../src/render/sprites.js");
  const s = await loadOakSprite();
  assert.equal(s.placeholder, false);
  assert.ok(s.w > 20 && s.h > 30);
});

// Every species the renderer can be asked to draw: the 151 dex entries plus
// the five out-of-dex Eeveelutions an existing save can still be sitting on.
const ALL_SPECIES = [
  ...SPECIES_ORDER,
  "espeon", "umbreon", "leafeon", "glaceon", "sylveon",
];

// seed/sprites/ is gitignored (Nintendo artwork, public repo), so a fresh
// checkout has none until `node scripts/bake-assets.mjs` has been run. That is
// a setup step not yet taken, not a defect -- these skip rather than fail, and
// say which command fixes it. The skip is all-or-nothing on purpose: a
// half-baked directory IS a real problem and should still fail loudly below.
const spriteDir = fileURLToPath(new URL("../seed/sprites/", import.meta.url));
const baked = existsSync(join(spriteDir, "bulbasaur.png"));
const skipReason = baked ? false : "seed/sprites is empty -- run: node scripts/bake-assets.mjs";

test("every drawable species has a baked sprite", { skip: skipReason }, async () => {
  const missing = [];
  for (const species of ALL_SPECIES) {
    const sprite = await loadBuddySprite(species);
    if (sprite.placeholder) missing.push(species);
  }
  assert.deepEqual(missing, [], `missing sprites: ${missing.join(", ")}`);
});

// An ink ratio this high means the calibrated threshold swallowed the body and
// the sprite arrived as a filled silhouette with its linework gone.
const INK_MAX = 0.34;

// gastly is baked by luminance bands rather than one threshold (BANDS in
// bake-assets.mjs): its gas is inked and its head deliberately is not, so the
// figure is a white line-art head inside a solid cloud. That lands at ~0.30,
// and both directions out of this window are regressions that were actually
// seen on 2026-07-29:
//   below ~0.22  the gas band has been clipped and only the head linework and
//                a few detached crumbs survive (a bare sphere, ink ~0.05)
//   above ~0.36  the head fill has been inked along with the gas and the whole
//                thing is one black disc again (ink ~0.51)
// A two-sided window rather than an exemption, because the 0.34 guard alone
// would let the clipped-gas version through silently.
const INK_WINDOW = { gastly: [0.22, 0.36] };

test("baked buddy sprites fill the slot without overflowing it", { skip: skipReason }, async () => {
  const problems = [];
  for (const species of ALL_SPECIES) {
    const s = await loadBuddySprite(species);
    const maxEdge = Math.max(s.w, s.h);
    const ink = s.gray.reduce((count, value) => count + (value < 128 ? 1 : 0), 0);
    const inkRatio = ink / s.gray.length;
    const [inkMin, inkMax] = INK_WINDOW[species] ?? [0, INK_MAX];
    // Collected rather than asserted one at a time: with 156 sprites, failing
    // on the first bad one means re-running the bake once per problem sprite.
    if (maxEdge > 157) problems.push(`${species} max edge ${maxEdge} exceeds slot 157`);
    if (maxEdge < 148) problems.push(`${species} max edge ${maxEdge} is under-sized (~155 expected)`);
    if (inkRatio >= inkMax) problems.push(`${species} ink ratio ${inkRatio.toFixed(3)} is at or above ${inkMax}`);
    if (inkRatio < inkMin) problems.push(`${species} ink ratio ${inkRatio.toFixed(3)} is below ${inkMin}`);
  }
  assert.deepEqual(problems, [], `${problems.length} sprite(s) out of spec:\n  ${problems.join("\n  ")}`);
});

test("ditherSpriteGray keeps sprite midtones as a 1-bit Bayer pattern", () => {
  const sprite = ditherSpriteGray(new Uint8Array(8 * 8).fill(128), 8, 8);

  assert.equal(sprite.length, 8 * 8);
  assert.ok(sprite.every((v) => v === 0 || v === 255));
  assert.ok(sprite.some((v) => v === 0));
  assert.ok(sprite.some((v) => v === 255));
});
