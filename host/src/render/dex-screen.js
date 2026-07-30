// The pokedex screen: all 151 in dex order, caught ones as the line art the
// buddy panel draws, the rest as solid silhouettes (the owner's call on
// 2026-07-30 -- he wanted the classic look and accepted that it gives every
// shape away at once).
//
// Cell size was chosen by looking, not by arithmetic: out/dex-grid-probe.mjs
// renders a page at several sizes, and at 30px the line art collapses into
// blobs while at 36px the species stay apart. 10x6 also happens to make the
// grid position readable as the dex number -- row 1 of page 1 is 1-10.
import { createCanvas } from "@napi-rs/canvas";

import { dexEntries } from "../pet/dex.js";
import { imageDataToFrame } from "./frame.js";
import { H, INK, LEFT_W, PAPER, W } from "./palette.js";
import { loadBuddySprite } from "./sprites.js";

const CJK = '"Zpix"';

export const DEX_COLS = 10;
export const DEX_ROWS = 6;
export const DEX_PAGE_SIZE = DEX_COLS * DEX_ROWS;   // 60 -> three pages of 151
const CELL = 36;
const CELL_GAP_Y = 6;
const GRID_TOP = 32;
const HEADER_Y = 18;
const FOOTER_Y = 294;

export function dexPageCount(total) {
  return Math.max(1, Math.ceil(total / DEX_PAGE_SIZE));
}

// Cells are cached because a page is 60 sprites and the screen is redrawn on
// every page turn: without this each turn re-reads and re-samples 60 PNGs.
// Keyed by species AND state, since the two renderings of one species are
// different bitmaps.
const cellCache = new Map();

export function clearDexCellCache() {
  cellCache.clear();
}

async function cellFor(species, caught) {
  const key = `${species}:${caught ? "art" : "shadow"}`;
  const hit = cellCache.get(key);
  if (hit) return hit;

  const sprite = await loadBuddySprite(species);
  const cell = downsample(sprite, CELL, caught);
  cellCache.set(key, cell);
  return cell;
}

// Box-filter down to the cell, NOT nearest-neighbour: at roughly 1:4 a
// nearest-neighbour sample lands between strokes and drops them, so the figure
// comes out as disconnected specks. Taking "any ink in the source box" instead
// keeps every stroke at the cost of thickening it, which is the right trade at
// this size.
//
function downsample(sprite, box, caught) {
  const scale = Math.min(box / sprite.w, box / sprite.h);
  const w = Math.max(1, Math.round(sprite.w * scale));
  const h = Math.max(1, Math.round(sprite.h * scale));
  const bits = new Uint8Array(w * h);

  for (let y = 0; y < h; y += 1) {
    const sy0 = Math.floor((y / h) * sprite.h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) / h) * sprite.h));
    for (let x = 0; x < w; x += 1) {
      const sx0 = Math.floor((x / w) * sprite.w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) / w) * sprite.w));
      let on = 0;
      outer:
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          if (sprite.gray[sy * sprite.w + sx] < 128) { on = 1; break outer; }
        }
      }
      bits[y * w + x] = on;
    }
  }
  return caught ? { bits, w, h } : { bits: fillOutline(bits, w, h), w, h };
}

// Turns line art into a solid shadow by inking everything the outline encloses.
//
// The obvious version -- "ink anything that is not paper" -- does not work, and
// was written first: these sprites are line art on TRANSPARENCY, which
// composites to white, so the inside of a figure is exactly as white as the page
// around it. There is no "inside" to test a pixel for. What separates them is
// reachability, so this floods the background inwards from the border and inks
// whatever the flood could not reach.
//
// It depends on the outline being closed, which is what makes the box filter
// above the right partner rather than a compromise: it thickens every stroke,
// sealing the hairline gaps that open when a 155px drawing is sampled to 36. A
// figure whose outline still leaks comes out as line art instead of a shadow --
// wrong, but visibly wrong, and not broken.
function fillOutline(bits, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x += 1) stack.push(x, 0, x, h - 1);
  for (let y = 0; y < h; y += 1) stack.push(0, y, w - 1, y);

  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = y * w + x;
    if (outside[i] || bits[i]) continue;
    outside[i] = 1;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }

  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i += 1) out[i] = outside[i] ? 0 : 1;
  return out;
}

export async function renderDexPage({ dex, page = 0, progress }) {
  const entries = dexEntries(dex);
  const pages = dexPageCount(entries.length);
  const current = ((page % pages) + pages) % pages;      // wraps both ways
  const slice = entries.slice(current * DEX_PAGE_SIZE, (current + 1) * DEX_PAGE_SIZE);

  const canvas = createCanvas(W, H);
  const g = canvas.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.fillStyle = PAPER;
  g.fillRect(0, 0, W, H);
  g.fillStyle = INK;

  g.font = `800 14px ${CJK}`;
  g.fillText(`图鉴 ${progress?.dexCaught ?? 0}/${progress?.dexTotal ?? entries.length}`, 10, HEADER_Y);
  g.textAlign = "right";
  g.fillText(`${current + 1}/${pages}`, W - 10, HEADER_Y);
  g.textAlign = "left";
  g.fillRect(10, HEADER_Y + 8, W - 20, 1);

  const padX = Math.floor((W - DEX_COLS * CELL) / (DEX_COLS + 1));
  for (let i = 0; i < slice.length; i += 1) {
    const entry = slice[i];
    const col = i % DEX_COLS;
    const row = Math.floor(i / DEX_COLS);
    const cell = await cellFor(entry.species, entry.caught);
    blit(g, cell, padX + col * (CELL + padX), GRID_TOP + row * (CELL + CELL_GAP_Y), CELL);
  }

  g.font = `700 12px ${CJK}`;
  const hint = "KEY 翻页 · 长按返回";
  g.fillText(hint, Math.round((W - g.measureText(hint).width) / 2), FOOTER_Y);

  return imageDataToFrame(g.getImageData(0, 0, W, H), W, H);
}

function blit(g, cell, bx, by, box) {
  const ox = bx + Math.round((box - cell.w) / 2);
  const oy = by + Math.round((box - cell.h) / 2);
  const img = g.createImageData(cell.w, cell.h);
  for (let i = 0; i < cell.bits.length; i += 1) {
    const value = cell.bits[i] ? 0 : 255;
    img.data[i * 4] = value;
    img.data[i * 4 + 1] = value;
    img.data[i * 4 + 2] = value;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, ox, oy);
}

export const DEX_SCREEN_GEOMETRY = { CELL, GRID_TOP, CELL_GAP_Y, LEFT_W };
