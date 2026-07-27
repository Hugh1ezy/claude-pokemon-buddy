import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

import { EEVEE_IDLE_CRY } from "../pet/cries.js";
import { zhName } from "../pet/species-meta.js";
import { drawIdleAccent } from "./idle-accents.js";
import { H, INK, LEFT_W, PAPER, W } from "./palette.js";
import { layoutText } from "./format.js";
import { drawSprite, line } from "./sprite-pipeline.js";

export { layoutText, formatReset, money } from "./format.js";
export { drawSprite, line, px } from "./sprite-pipeline.js";

export const ZPIX_FONT_PATH = fileURLToPath(new URL("../../seed/fonts/zpix.ttf", import.meta.url));
GlobalFonts.registerFromPath(ZPIX_FONT_PATH, "Zpix");

const MONO = '"Zpix"';
const CJK = '"Zpix"';
const MOOD_ZH = { shocked: "震惊", fainted: "力竭", strained: "吃力", focused: "专注", happy: "开心" };
export const BUDDY_SPRITE_SLOT = 156;
export const BUDDY_SPRITE_SCALE = 3;
export const BUDDY_BOB = [0, -1, -2, -1]; // 呼吸浮动（周期 4，幅度 ≤2px）
const BUDDY_SPRITE_TOP = 46;
const BOLD_LINE_SPECIES = new Set();
export function buddyBold(species) {
  return BOLD_LINE_SPECIES.has(species ?? "eevee");
}
const TODAY_TEXT_X = 11;
const TODAY_TEXT_MAX_X = LEFT_W - 12;
// 14px：2026-07-07 视觉伴侣选型定稿——时钟 24px、说明四行 14px 加粗。
// 14 不是 Zpix 12px 网格的整数倍，但真机渲染实测（加粗后）足够干净，owner 拍板。
const TODAY_FONT = { weight: 800, size: 14, minSize: 12, family: MONO };
const BOND_SOFT_CAP = 180;
const HEART_MAX = 5;

export function drawGray(model) {
  const canvas = createCanvas(W, H);
  const g = canvas.getContext("2d");

  g.imageSmoothingEnabled = false;
  g.fillStyle = PAPER;
  g.fillRect(0, 0, W, H);
  g.textBaseline = "alphabetic";
  g.lineWidth = 2;
  g.strokeStyle = INK;
  g.fillStyle = INK;

  drawLeftPanel(g, model);
  drawBuddyPanel(g, model);

  return g.getImageData(0, 0, W, H);
}

function drawLeftPanel(g, model) {
  const text = layoutText(model);
  g.fillStyle = INK;
  g.fillRect(LEFT_W - 2, 0, 2, H);

  g.font = `800 12px ${MONO}`;
  g.fillText("CLAUDE", 10, 26);
  g.font = `700 24px ${MONO}`;
  const clockLeftX = LEFT_W - 12 - g.measureText(text.clock).width;
  g.textAlign = "right";
  g.fillText(text.clock, LEFT_W - 12, 28);
  g.textAlign = "left";
  if (typeof model.room?.battery === "number") {
    drawBatteryIndicator(g, clockLeftX, model.room.battery, model.buddy?.animPhase);
  }
  line(g, 10, 36, LEFT_W - 12, 36);

  const p5h = clampPct(model.p5h);
  const p5hText = text.p5h;
  g.font = `800 48px ${MONO}`;
  g.fillText(p5hText, 9, 88);
  if (p5hText !== "--") {
    const pctX = Math.round(9 + g.measureText(p5hText).width - 2);
    g.font = `800 24px ${MONO}`;
    g.fillText("%", pctX, 87);
  }
  g.font = `800 12px ${MONO}`;
  g.fillText("5H", 151, 58);
  g.fillText("WINDOW", 151, 72);

  g.font = `800 14px ${MONO}`;
  g.fillText(text.resets5h, 11, 115);

  if (text.rateNote) {
    g.font = `700 12px ${MONO}`;
    g.fillText(text.rateNote, 11, 46);
  }

  g.font = `800 12px ${MONO}`;
  g.fillText("WEEK", 11, 140);
  drawMeter(g, 56, 127, 92, 16, clampPct(model.pweek), { striped: true });
  g.font = `800 14px ${MONO}`;
  g.textAlign = "right";
  g.fillText(text.pweek === "--" ? "--" : `${text.pweek}%`, LEFT_W - 12, 142);
  g.textAlign = "left";

  g.font = `800 14px ${MONO}`;
  g.fillText(text.resetsWeek, 11, 167);
  g.font = fitTodayLineFont(g, text.today);
  g.fillText(text.today, TODAY_TEXT_X, 192);

  line(g, 10, 201, LEFT_W - 12, 201);
  // Weather: condition + temp enlarged to a secondary focal point.
  g.save();
  g.translate(11, 206);
  g.scale(1.35, 1.35);
  drawWeatherIcon(g, weatherIconKind(model.weather), 0, 0);
  g.restore();
  g.font = `800 24px ${CJK}`;
  g.fillText(text.weatherMain, 56, 232);
  g.font = `600 12px ${CJK}`;
  g.fillText(text.weatherDetail, 11, 253);

  line(g, 10, 260, LEFT_W - 12, 260);
  g.font = `700 12px ${CJK}`;
  g.fillText(`室内  ${tempHum(model.room)}`, 11, 278);
  g.fillText(`室外  ${tempHum(model.out)}`, 11, 295);
}

function drawBuddyPanel(g, model) {
  const panelX = LEFT_W;
  const panelW = W - LEFT_W;
  const buddy = model.buddy ?? {};
  const hasAnimPhase = Number.isInteger(buddy.animPhase); // 缺省 → bob=0 且不画 accent（既有渲染零变化）
  const phase = hasAnimPhase ? buddy.animPhase : 0;
  const bob = BUDDY_BOB[phase % BUDDY_BOB.length];
  const hop = Number.isInteger(buddy.hop) ? buddy.hop : 0;

  drawBubble(g, W - 8, 11, buddy.bubble ?? EEVEE_IDLE_CRY);
  drawShadow(g, panelX + panelW / 2, 200);
  drawSprite(g, buddy.spriteGray, {
    x: panelX + Math.floor((panelW - BUDDY_SPRITE_SLOT) / 2),
    y: BUDDY_SPRITE_TOP + bob - hop,
    maxSize: BUDDY_SPRITE_SLOT,
    srcW: buddy.spriteW,
    srcH: buddy.spriteH,
    bold: buddyBold(buddy.species),
  });
  if (hasAnimPhase) {
    drawIdleAccent(g, buddy.species ?? "eevee", {
      x: panelX + Math.floor((panelW - BUDDY_SPRITE_SLOT) / 2),
      y: BUDDY_SPRITE_TOP + bob - hop,
      w: BUDDY_SPRITE_SLOT,
      h: BUDDY_SPRITE_SLOT,
    }, phase);
  }
  drawSpeciesLine(g, panelX, panelW, buddy);

  g.fillStyle = INK;
  g.font = `800 12px ${MONO}`;
  g.fillRect(panelX + 14, 219, 7, 7);
  g.fillText(MOOD_ZH[buddy.mood] ?? buddy.mood ?? "专注", panelX + 27, 227);

  const level = Math.max(1, Number(buddy.level ?? 1));
  const hearts = heartCount(buddy.bond ?? 0);
  const streak = Math.max(0, Number(model.streak ?? 0));

  // 等级 + 连续天数（24px = Zpix 整数倍，清晰）
  g.font = `800 24px ${MONO}`;
  g.fillText(`Lv.${level}`, panelX + 14, 253);
  drawFlame(g, panelX + 104, 237);
  g.fillText(`${streak}天`, panelX + 122, 253);

  // 经验条
  drawMeter(g, panelX + 14, 262, 156, 11, clampPct(buddy.expPct ?? 0), { striped: false });

  // 亲密度
  g.font = `700 12px ${CJK}`;
  g.fillText("亲密度", panelX + 14, 296);
  drawHearts(g, panelX + 58, 284, hearts);
}

function drawSpeciesLine(g, panelX, panelW, buddy) {
  const cx = panelX + panelW / 2;
  g.font = `800 12px ${CJK}`;
  g.textAlign = "left"; // Zpix 12px 过 1-bit 需整数左边缘, 自算 center 再 round (避免半像素碎裂)
  const centered = (t) => g.fillText(t, Math.round(cx - g.measureText(t).width / 2), 212);
  if (buddy.readyToEvolve) {
    g.fillStyle = INK;
    g.fillRect(panelX + 18, 198, panelW - 36, 18);
    g.fillStyle = PAPER;
    centered("▲ 按 KEY 进化！");
  } else {
    g.fillStyle = INK;
    centered(zhName(buddy.species ?? "eevee"));
  }
  g.fillStyle = INK;
}

export function fitTodayLineFont(g, text) {
  return fitFont(g, text, {
    ...TODAY_FONT,
    maxWidth: TODAY_TEXT_MAX_X - TODAY_TEXT_X,
  });
}

function drawMeter(g, x, y, w, h, pct, { striped }) {
  g.strokeStyle = INK;
  g.lineWidth = 2;
  g.strokeRect(x, y, w, h);
  const innerW = Math.max(0, Math.round((w - 4) * pct / 100));
  g.fillStyle = INK;
  g.fillRect(x + 2, y + 2, innerW, h - 4);

  if (striped) {
    g.strokeStyle = PAPER;
    g.lineWidth = 1;
    for (let sx = x + 5; sx < x + 2 + innerW; sx += 6) {
      line(g, sx, y + 2, sx, y + h - 2);
    }
  }

  g.fillStyle = INK;
  g.strokeStyle = INK;
  g.lineWidth = 2;
}

function drawBubble(g, rightX, y, text) {
  g.font = `700 24px ${MONO}`;
  const w = Math.ceil(g.measureText(text).width) + 22;
  const x = rightX - w;
  g.fillStyle = PAPER;
  g.strokeStyle = INK;
  g.lineWidth = 2;
  roundedRect(g, x, y, w, 36, 9);
  g.fill();
  g.stroke();
  g.fillStyle = INK;
  g.fillText(text, x + 11, y + 27);
}

function drawShadow(g, cx, y) {
  const rx = 57;
  const ry = 10;
  const left = Math.ceil(cx - rx);
  const right = Math.floor(cx + rx);
  const top = Math.ceil(y - ry);
  const bottom = Math.floor(y + ry);
  g.fillStyle = INK;
  for (let yy = top; yy <= bottom; yy += 1) {
    for (let xx = left; xx <= right; xx += 1) {
      if (((xx + yy) & 1) !== 0) continue;
      const dx = (xx - cx) / rx;
      const dy = (yy - y) / ry;
      if (dx * dx + dy * dy <= 1) g.fillRect(xx, yy, 1, 1);
    }
  }
  g.fillStyle = INK;
}

function drawWeatherIcon(g, kind, x, y) {
  if (kind === "sun") {
    drawSunIcon(g, x, y);
  } else if (kind === "rain") {
    drawCloudIcon(g, x, y);
    drawRainIcon(g, x, y);
  } else if (kind === "snow") {
    drawCloudIcon(g, x, y);
    drawSnowIcon(g, x, y);
  } else if (kind === "fog") {
    drawFogIcon(g, x, y);
  } else {
    drawCloudIcon(g, x, y);
  }
}

function drawSunIcon(g, x, y) {
  g.fillStyle = INK;
  g.strokeStyle = INK;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(x + 15, y + 12, 7, 0, Math.PI * 2);
  g.fill();
  line(g, x + 15, y, x + 15, y + 4);
  line(g, x + 15, y + 20, x + 15, y + 24);
  line(g, x + 3, y + 12, x + 7, y + 12);
  line(g, x + 23, y + 12, x + 27, y + 12);
  line(g, x + 6, y + 3, x + 9, y + 6);
  line(g, x + 21, y + 18, x + 24, y + 21);
  line(g, x + 24, y + 3, x + 21, y + 6);
  line(g, x + 9, y + 18, x + 6, y + 21);
}

function drawCloudIcon(g, x, y) {
  g.fillStyle = INK;
  g.beginPath();
  g.arc(x + 8, y + 11, 6, Math.PI, 0);
  g.arc(x + 15, y + 8, 8, Math.PI, 0);
  g.arc(x + 24, y + 12, 6, Math.PI, 0);
  g.rect(x + 4, y + 11, 25, 7);
  g.fill();
}

function drawRainIcon(g, x, y) {
  g.strokeStyle = INK;
  g.lineWidth = 2;
  line(g, x + 9, y + 21, x + 7, y + 25);
  line(g, x + 17, y + 21, x + 15, y + 25);
  line(g, x + 25, y + 21, x + 23, y + 25);
}

function drawSnowIcon(g, x, y) {
  g.strokeStyle = INK;
  g.lineWidth = 1;
  drawAsterisk(g, x + 10, y + 23);
  drawAsterisk(g, x + 21, y + 23);
  g.lineWidth = 2;
}

function drawFogIcon(g, x, y) {
  g.strokeStyle = INK;
  g.lineWidth = 2;
  line(g, x + 4, y + 7, x + 28, y + 7);
  line(g, x, y + 14, x + 24, y + 14);
  line(g, x + 4, y + 21, x + 28, y + 21);
}

function drawAsterisk(g, x, y) {
  line(g, x - 3, y, x + 3, y);
  line(g, x, y - 3, x, y + 3);
  line(g, x - 2, y - 2, x + 2, y + 2);
  line(g, x + 2, y - 2, x - 2, y + 2);
}

function drawFlame(g, x, y) {
  g.fillStyle = INK;
  g.beginPath();
  g.moveTo(x + 6, y);
  g.bezierCurveTo(x + 13, y + 7, x + 11, y + 15, x + 6, y + 16);
  g.bezierCurveTo(x, y + 14, x - 1, y + 8, x + 4, y + 4);
  g.bezierCurveTo(x + 4, y + 8, x + 8, y + 8, x + 6, y);
  g.fill();
}

function drawHearts(g, x, y, filled) {
  for (let i = 0; i < 5; i += 1) {
    drawHeart(g, x + i * 20, y, Math.max(0, Math.min(1, filled - i)));
  }
}

function drawHeart(g, x, y, fill) {
  heartPath(g, x, y);

  if (fill >= 1) {
    g.fillStyle = INK;
    g.fill();
    return;
  }

  if (fill > 0) {
    g.save();
    g.clip();
    g.fillStyle = INK;
    g.fillRect(x, y, Math.round(8 * fill), 14);
    g.restore();
  }

  heartPath(g, x, y);
  g.strokeStyle = INK;
  g.lineWidth = 1;
  g.stroke();
  g.lineWidth = 2;
}

function heartPath(g, x, y) {
  g.beginPath();
  g.moveTo(x + 5, y + 10);
  g.bezierCurveTo(x, y + 6, x, y + 1, x + 4, y + 1);
  g.bezierCurveTo(x + 6, y + 1, x + 7, y + 2, x + 8, y + 4);
  g.bezierCurveTo(x + 9, y + 2, x + 10, y + 1, x + 12, y + 1);
  g.bezierCurveTo(x + 16, y + 1, x + 16, y + 6, x + 11, y + 10);
  g.lineTo(x + 8, y + 13);
  g.closePath();
}

function roundedRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

export function heartCount(rawBond) {
  const perHeart = BOND_SOFT_CAP / HEART_MAX;
  const v = Math.round(((Number(rawBond) || 0) / perHeart) * 2) / 2;
  return Math.max(0, Math.min(HEART_MAX, v));
}

const BATTERY_SEGMENTS = 4; // one segment = 25%, per design choice (no numeric readout on screen)
const BATTERY_CRITICAL_PCT = 10;

// Small battery glyph (outline + nub + up to 4 filled segments) placed just
// left of the clock, right-anchored at `rightX` so it never collides with
// the clock text regardless of how wide the current time string renders.
// No numeric percent is drawn -- only which of the 4 quarters are lit.
// Below BATTERY_CRITICAL_PCT it blinks: `animPhase` is the buddy animator's
// free-running counter (increments every ~333ms independent of the main
// 60s tick, see buddy-animator.js), so this needs no timer of its own --
// every other ~666ms half-cycle the whole icon is simply not drawn.
function drawBatteryIndicator(g, rightX, pct, animPhase) {
  const clamped = Math.max(0, Math.min(100, pct));
  const blinkedOut = clamped < BATTERY_CRITICAL_PCT && Math.floor((animPhase ?? 0) / 2) % 2 === 1;
  if (blinkedOut) return;

  const iconW = 20;
  const iconH = 10;
  const nubW = 2;
  const segGap = 1;
  const iconX = rightX - 4 - iconW - nubW;
  const iconY = 11;

  g.save();
  g.lineWidth = 1.5;
  g.strokeStyle = INK;
  g.strokeRect(iconX, iconY, iconW, iconH);
  g.fillStyle = INK;
  g.fillRect(iconX + iconW, iconY + (iconH - 4) / 2, nubW, 4);

  const litSegments = Math.round((clamped / 100) * BATTERY_SEGMENTS);
  const innerH = iconH - 4;
  const innerW = iconW - 4;
  const segW = (innerW - segGap * (BATTERY_SEGMENTS - 1)) / BATTERY_SEGMENTS;
  for (let i = 0; i < litSegments; i++) {
    g.fillRect(iconX + 2 + i * (segW + segGap), iconY + 2, segW, innerH);
  }
  g.restore();
}

function tempHum(v) {
  if (!v) return "--°C · --%";
  const temp = typeof v.t === "number" && Number.isFinite(v.t) ? v.t.toFixed(1) : "--";
  const humidity = typeof v.h === "number" && Number.isFinite(v.h) ? Math.round(v.h) : "--";
  return `${temp}°C · ${humidity}%`;
}

function fitFont(g, text, { weight, size, minSize, family, maxWidth }) {
  // Zpix is a 12px pixel font: only integer multiples of 12 render clean 1-bit,
  // so step by whole grid sizes instead of single pixels.
  for (let px = size; px >= minSize; px -= 12) {
    const font = `${weight} ${px}px ${family}`;
    g.font = font;
    if (g.measureText(text).width <= maxWidth) return font;
  }
  return `${weight} ${minSize}px ${family}`;
}

function clampPct(v) {
  if (v == null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function weatherIconKind(weather = {}) {
  const cond = String(weather?.cond ?? "");
  if (/雪|snow/i.test(cond)) return "snow";
  if (/雨|雷|rain|storm|shower/i.test(cond)) return "rain";
  if (/雾|霾|fog|mist|haze/i.test(cond)) return "fog";
  if (/晴|clear|sun/i.test(cond)) return "sun";
  return "cloud";
}
