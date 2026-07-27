import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";

import { drawHeart } from "../src/render/layout.js";

// The partial fill is a clipped rect, so getting its width wrong does not throw
// or misplace anything -- it just quietly under-fills, which is invisible to
// every assertion that does not actually look at the pixels. A half heart was
// rendering as roughly a quarter for exactly that reason.
const W = 30;
const H = 20;
const AT = { x: 6, y: 3 };

function inkColumns(fill) {
  const canvas = createCanvas(W, H);
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, W, H);
  drawHeart(g, AT.x, AT.y, fill);

  const { data } = g.getImageData(0, 0, W, H);
  const columns = [];
  for (let x = 0; x < W; x += 1) {
    let dark = 0;
    for (let y = 0; y < H; y += 1) {
      const i = (y * W + x) * 4;
      if (data[i] < 128 && data[i + 3] > 128) dark += 1;
    }
    columns.push(dark);
  }
  return columns;
}

const total = (columns) => columns.reduce((sum, n) => sum + n, 0);

test("a half heart is filled to its horizontal middle, not a sliver", () => {
  const empty = total(inkColumns(0));
  const half = total(inkColumns(0.5));
  const full = total(inkColumns(1));

  assert.ok(full > empty, "a full heart must be more ink than an outline");

  // The whole point: half must land near the midpoint between outline and
  // solid. The old 8-wide fill put it at roughly a fifth of the way up, which
  // is what "only a little bit is black" looked like on the panel.
  const share = (half - empty) / (full - empty);
  assert.ok(share > 0.35 && share < 0.65, `half heart filled ${(share * 100).toFixed(0)}% of the shape`);
});

test("a half heart fills the left side and leaves the right side outline-only", () => {
  const empty = inkColumns(0);
  const half = inkColumns(0.5);
  const mid = AT.x + 8;   // heartPath spans x .. x+16

  const addedLeft = half.slice(0, mid).reduce((s, n, i) => s + (n - empty[i]), 0);
  const addedRight = half.slice(mid).reduce((s, n, i) => s + (n - empty[mid + i]), 0);

  assert.ok(addedLeft > 0, "the left half should have gained ink");
  assert.equal(addedRight, 0, "nothing right of the midpoint should be filled");
});

test("an empty heart still draws its outline, and a full one is solid", () => {
  assert.ok(total(inkColumns(0)) > 0, "an unearned heart is an outline, not nothing");
  const full = inkColumns(1);
  // Solid means the middle column is inked top to bottom of the shape, not just
  // its two outline pixels.
  assert.ok(full[AT.x + 8] > 8, "a full heart's centre column should be solid");
});
