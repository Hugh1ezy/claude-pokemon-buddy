// The capture screen. Draws the wild pokemon -- this is where the species is
// finally revealed, row 3 having deliberately withheld it -- the ball, and the
// timing bar along the bottom.
//
// Every frame is a pure function of (state, elapsed ms), with no timers of its
// own, so the loop that drives it can be tested by handing it numbers.
import { createCanvas } from "@napi-rs/canvas";

import { sliderBands } from "../pet/capture.js";
import { imageDataToFrame } from "./frame.js";
import { H, INK, PAPER, W } from "./palette.js";
import { drawSprite } from "./sprite-pipeline.js";
import { loadBuddySprite } from "./sprites.js";

const CJK = '"Zpix"';

const BAR_X = 24;
const BAR_W = W - BAR_X * 2;
const BAR_Y = 258;
const BAR_H = 26;
const SPRITE_SLOT = 140;
const SPRITE_TOP = 56;
const GROUND_Y = SPRITE_TOP + SPRITE_SLOT;

export const PHASE = {
  AIM: "aim",
  THROW: "throw",
  WOBBLE: "wobble",
  CAUGHT: "caught",
  RETRY: "retry",
  ESCAPED: "escaped",
};

// Animation lengths, in ms. The throw and the wobble are the whole reason the
// outcome is not just a line of text: the owner asked for the GBA beat --
// ball flies, ball rocks, and only then do you find out.
export const PHASE_MS = {
  [PHASE.THROW]: 480,
  [PHASE.WOBBLE]: 1500,
  [PHASE.CAUGHT]: 1400,
  [PHASE.RETRY]: 900,
  [PHASE.ESCAPED]: 1400,
};

export async function renderCaptureFrame({ species, phase, elapsed = 0, state, zh }) {
  const canvas = createCanvas(W, H);
  const g = canvas.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.fillStyle = PAPER;
  g.fillRect(0, 0, W, H);
  g.fillStyle = INK;

  g.font = `800 14px ${CJK}`;
  const title = titleFor(phase, zh);
  g.fillText(title, Math.round((W - g.measureText(title).width) / 2), 30);

  const sprite = await loadBuddySprite(species);
  const spriteX = Math.round((W - SPRITE_SLOT) / 2);

  // The pokemon is hidden from the moment the ball lands until the outcome is
  // known -- that is what makes the wobble suspenseful rather than decorative.
  const hidden = phase === PHASE.WOBBLE || phase === PHASE.CAUGHT;
  if (!hidden) {
    const flee = phase === PHASE.ESCAPED ? Math.round((elapsed / PHASE_MS[PHASE.ESCAPED]) * 90) : 0;
    drawSprite(g, sprite.gray, {
      x: spriteX, y: SPRITE_TOP - flee, maxSize: SPRITE_SLOT, srcW: sprite.w, srcH: sprite.h,
    });
  }

  if (phase === PHASE.THROW) drawThrownBall(g, elapsed / PHASE_MS[PHASE.THROW], spriteX);
  if (phase === PHASE.WOBBLE) drawBall(g, W / 2, GROUND_Y - 10, wobbleTilt(elapsed));
  if (phase === PHASE.CAUGHT) { drawBall(g, W / 2, GROUND_Y - 10, 0); drawStars(g, W / 2, GROUND_Y - 10, elapsed); }
  if (phase === PHASE.RETRY) drawBurst(g, W / 2, GROUND_Y - 10, elapsed / PHASE_MS[PHASE.RETRY]);

  // The bar stays up through every phase except the two that end the encounter,
  // so the piece does not vanish and reappear between throws.
  if (phase !== PHASE.CAUGHT && phase !== PHASE.ESCAPED) {
    drawBar(g, state, phase === PHASE.AIM ? elapsed : state.frozenAt ?? elapsed);
  }

  return imageDataToFrame(g.getImageData(0, 0, W, H), W, H);
}

function titleFor(phase, zh) {
  switch (phase) {
    case PHASE.CAUGHT: return `捉到了！${zh}`;
    case PHASE.RETRY: return "差一点⋯⋯再来！";
    case PHASE.ESCAPED: return `${zh} 跑掉了`;
    default: return `野生的 ${zh}`;
  }
}

// A: the fixed line. B: the solid block you have to hit. C: the outline around
// it that costs the throw but not the encounter.
function drawBar(g, state, t) {
  const bands = sliderBands(state, t);
  const at = (fraction) => Math.round(BAR_X + fraction * BAR_W);

  g.fillStyle = INK;
  g.fillRect(BAR_X, BAR_Y, BAR_W, 2);
  g.fillRect(BAR_X, BAR_Y + BAR_H - 2, BAR_W, 2);
  g.fillRect(BAR_X, BAR_Y, 2, BAR_H);
  g.fillRect(BAR_X + BAR_W - 2, BAR_Y, 2, BAR_H);

  // C first, as an outline, so B can sit inside it solid.
  const c0 = at(bands.c[0]);
  const c1 = at(bands.c[1]);
  g.fillRect(c0, BAR_Y + 5, c1 - c0, 2);
  g.fillRect(c0, BAR_Y + BAR_H - 7, c1 - c0, 2);
  g.fillRect(c0, BAR_Y + 5, 2, BAR_H - 10);
  g.fillRect(c1 - 2, BAR_Y + 5, 2, BAR_H - 10);

  const b0 = at(bands.b[0]);
  g.fillRect(b0, BAR_Y + 5, Math.max(2, at(bands.b[1]) - b0), BAR_H - 10);

  // A last and full height, so it stays visible on top of a solid B.
  const a = at(bands.target);
  g.fillRect(a - 1, BAR_Y - 6, 3, BAR_H + 12);
}

function drawBall(g, cx, cy, tilt) {
  const r = 13;
  g.save();
  g.translate(cx, cy);
  g.rotate(tilt);
  g.fillStyle = INK;
  g.beginPath();
  g.arc(0, 0, r, 0, Math.PI * 2);
  g.fill();
  // The band and the button, in paper, so it reads as a pokeball at 1 bit
  // rather than as a dot.
  g.fillStyle = PAPER;
  g.fillRect(-r, -2, r * 2, 4);
  g.beginPath();
  g.arc(0, 0, 4, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = INK;
  g.beginPath();
  g.arc(0, 0, 2, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

// Three rocks, decaying -- the classic count, and it ends upright so a caught
// frame does not jump.
function wobbleTilt(elapsed) {
  const u = Math.min(1, elapsed / PHASE_MS[PHASE.WOBBLE]);
  return Math.sin(u * Math.PI * 6) * 0.45 * (1 - u);
}

function drawThrownBall(g, u, spriteX) {
  const from = { x: 40, y: GROUND_Y - 4 };
  const to = { x: W / 2, y: SPRITE_TOP + SPRITE_SLOT / 2 };
  const x = from.x + (to.x - from.x) * u;
  const y = from.y + (to.y - from.y) * u - Math.sin(u * Math.PI) * 70;   // arc
  drawBall(g, Math.round(x), Math.round(y), u * Math.PI * 3);
  if (u > 0.92) drawStars(g, to.x, to.y, 120);                          // the hit
}

function drawStars(g, cx, cy, elapsed) {
  const u = Math.min(1, elapsed / 700);
  const spread = 14 + u * 26;
  g.fillStyle = INK;
  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * Math.PI * 2 + u;
    star(g, Math.round(cx + Math.cos(angle) * spread), Math.round(cy + Math.sin(angle) * spread), 5 - Math.round(u * 2));
  }
}

// A four-point sparkle, drawn as two tapering bars: at this size a five-pointed
// star turns into a blob.
function star(g, cx, cy, r) {
  if (r < 2) return;
  for (let i = -r; i <= r; i += 1) {
    const thin = Math.max(0, Math.round((r - Math.abs(i)) / 2));
    g.fillRect(cx + i, cy - thin, 1, thin * 2 + 1);
    g.fillRect(cx - thin, cy + i, thin * 2 + 1, 1);
  }
}

function drawBurst(g, cx, cy, u) {
  const spread = 6 + u * 30;
  g.fillStyle = INK;
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * Math.PI * 2;
    const x = Math.round(cx + Math.cos(angle) * spread);
    const y = Math.round(cy + Math.sin(angle) * spread);
    g.fillRect(x - 2, y - 2, 4, 4);
  }
}

export const CAPTURE_GEOMETRY = { BAR_X, BAR_W, BAR_Y, BAR_H, SPRITE_TOP, SPRITE_SLOT };
