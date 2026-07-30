import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEX_PAGE_SIZE,
  LIT_COVERAGE,
  clearDexCellCache,
  dexPageCount,
  renderDexPage,
} from "../src/render/dex-screen.js";
import { normalizeDex } from "../src/pet/dex.js";
import { SPECIES_ORDER } from "../src/pet/species-meta.js";

const dexOf = (caught) => normalizeDex({ dexCaught: caught, capturedCount: caught.length, box: [] });

function inkRatio(bitmap, { x0 = 0, y0 = 0, x1 = bitmap.w, y1 = bitmap.h } = {}) {
  const rowBytes = Math.ceil(bitmap.w / 8);
  let ink = 0;
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      total += 1;
      if ((bitmap.bytes[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1) ink += 1;
    }
  }
  return ink / total;
}

test("151 entries land on three pages", () => {
  assert.equal(DEX_PAGE_SIZE, 60);
  assert.equal(dexPageCount(151), 3);
  assert.equal(dexPageCount(60), 1);
  assert.equal(dexPageCount(61), 2);
  assert.equal(dexPageCount(0), 1, "an empty dex still has a page to show");
});

// The whole point of the screen: an uncaught entry is a solid shadow and a
// caught one is the line art. The first attempt inked "anything not paper",
// which on line-art-over-transparency inks only the strokes -- so every entry
// rendered identically and the screen silently lost its only distinction.
test("an uncaught entry is a filled shadow and a caught one is not", async () => {
  clearDexCellCache();
  const first = SPECIES_ORDER[0];

  const none = await renderDexPage({ dex: dexOf([]), page: 0, progress: { dexCaught: 0, dexTotal: 151 } });
  const one = await renderDexPage({ dex: dexOf([first]), page: 0, progress: { dexCaught: 1, dexTotal: 151 } });

  // The top-left cell, generously bounded.
  const cell = { x0: 2, y0: 32, x1: 40, y1: 68 };
  const shadow = inkRatio(none.bitmap, cell);
  const art = inkRatio(one.bitmap, cell);

  assert.ok(shadow > 0.30, `a shadow should be mostly ink, got ${shadow.toFixed(3)}`);
  assert.ok(art < shadow * 0.75, `line art should be markedly lighter than a shadow (${art.toFixed(3)} vs ${shadow.toFixed(3)})`);
  assert.ok(art > 0.02, `line art should still draw something, got ${art.toFixed(3)}`);
});

// The owner asked for the lit cells to be thinner on 2026-07-30. They are thin
// because the box filter demands LIT_COVERAGE of a source box before inking,
// where the silhouette path demands only "any ink at all" -- and it has to keep
// demanding that, because fillOutline can only work on an outline the fattening
// has sealed. Losing this distinction is a one-character edit, so it is pinned.
test("lit cells are drawn thinner than the silhouette rule would draw them", async () => {
  clearDexCellCache();
  assert.ok(LIT_COVERAGE > 0, "a coverage of 0 is the fat 'any ink' rule the owner rejected");
  assert.ok(LIT_COVERAGE < 0.26, "0.26 and up starts dropping strokes on the delicate species");

  const first = SPECIES_ORDER[0];
  const cell = { x0: 2, y0: 32, x1: 40, y1: 68 };
  const lit = await renderDexPage({ dex: dexOf([first]), page: 0, progress: { dexCaught: 1, dexTotal: 151 } });
  const shadow = await renderDexPage({ dex: dexOf([]), page: 0, progress: { dexCaught: 0, dexTotal: 151 } });

  assert.ok(
    inkRatio(lit.bitmap, cell) < inkRatio(shadow.bitmap, cell),
    "a lit cell must never carry as much ink as the shadow it replaced",
  );
});

test("catching something changes only its own cell", async () => {
  clearDexCellCache();
  const before = await renderDexPage({ dex: dexOf([]), page: 0, progress: { dexCaught: 0, dexTotal: 151 } });
  const after = await renderDexPage({ dex: dexOf([SPECIES_ORDER[0]]), page: 0, progress: { dexCaught: 0, dexTotal: 151 } });

  // Second cell along, which must be untouched.
  const neighbour = { x0: 42, y0: 32, x1: 78, y1: 68 };
  assert.equal(inkRatio(before.bitmap, neighbour), inkRatio(after.bitmap, neighbour));
});

test("pages show different species, and the page number wraps both ways", async () => {
  clearDexCellCache();
  const dex = dexOf([]);
  const progress = { dexCaught: 0, dexTotal: 151 };
  const p0 = await renderDexPage({ dex, page: 0, progress });
  const p1 = await renderDexPage({ dex, page: 1, progress });

  const body = { x0: 0, y0: 30, x1: 400, y1: 280 };
  assert.notEqual(inkRatio(p0.bitmap, body), inkRatio(p1.bitmap, body), "two pages must not be the same 60 species");

  // Out-of-range pages resolve rather than render blank: the view's wrap and
  // the renderer's must agree, and the renderer is the one that gets a raw
  // number if anything ever drives it directly.
  const wrapped = await renderDexPage({ dex, page: 3, progress });
  assert.equal(inkRatio(wrapped.bitmap, body), inkRatio(p0.bitmap, body));
  const negative = await renderDexPage({ dex, page: -1, progress });
  const p2 = await renderDexPage({ dex, page: 2, progress });
  assert.equal(inkRatio(negative.bitmap, body), inkRatio(p2.bitmap, body));
});

test("the last page is short and draws no cells past the end of the dex", async () => {
  clearDexCellCache();
  const last = await renderDexPage({
    dex: dexOf([]), page: 2, progress: { dexCaught: 0, dexTotal: 151 },
  });

  // 151 = 60 + 60 + 31, so page 3 fills three rows and part of a fourth; the
  // bottom two rows must be empty.
  const tail = { x0: 0, y0: 32 + 4 * 42, x1: 400, y1: 280 };
  assert.equal(inkRatio(last.bitmap, tail), 0, "nothing may be drawn past entry 151");
});

test("the header reports progress rather than the page's own contents", async () => {
  clearDexCellCache();
  const header = { x0: 0, y0: 6, x1: 200, y1: 24 };
  const a = await renderDexPage({ dex: dexOf([]), page: 0, progress: { dexCaught: 7, dexTotal: 151 } });
  const b = await renderDexPage({ dex: dexOf([]), page: 0, progress: { dexCaught: 8, dexTotal: 151 } });

  assert.notEqual(inkRatio(a.bitmap, header), inkRatio(b.bitmap, header));
});
