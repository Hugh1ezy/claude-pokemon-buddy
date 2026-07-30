import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

import { EEVEE_IDLE_CRY } from "../pet/cries.js";
import { displayName, zhName } from "../pet/species-meta.js";
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
const BUDDY_SPRITE_TOP = 86; // shifted down from its original 46 to leave room for row 3 (mood + bubble) above it
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

  g.font = `700 24px ${MONO}`;
  g.textAlign = "right";
  g.fillText(text.clock, LEFT_W - 12, 28);
  g.textAlign = "left";
  if (typeof model.room?.battery === "number") {
    drawBatteryIndicator(g, 10, model.room.battery, model.buddy?.animPhase);
  }
  line(g, 10, 36, LEFT_W - 12, 36);

  const centerInPanel = (t, y) => {
    g.fillText(t, Math.round(LEFT_W / 2 - g.measureText(t).width / 2), y);
  };

  // Row 1: title
  g.font = `700 12px ${MONO}`;
  centerInPanel("Pokemon · Clock", 55);

  // Row 2: date flush left, weekday flush right -- the same 11/12px margins the
  // rows above and below use, so the two ends of the row line up with everything
  // else in the panel rather than floating in the middle.
  // The date at 1.5x its original 14px, at the owner's ask. The weekday stays
  // at 14px because the two at 21px measure 200px against 193px of usable row
  // and collide -- "2026年7月30日周四" with no gap. Enlarging both needs the
  // year dropped or the row split, which is a content decision, not a font one.
  g.font = `800 ${DATE_PX}px ${CJK}`;
  g.fillText(text.date, 11, 88);
  g.font = `800 ${WEEKDAY_PX}px ${CJK}`;
  g.textAlign = "right";
  g.fillText(text.weekday, LEFT_W - 12, 88);
  g.textAlign = "left";

  // Row 3: the wild encounter notification, drawn only while one is on offer.
  drawEncounterRow(g, model);

  // Row 4: pokedex progress -- always drawn, since "how far along am I" is the
  // question the whole 151-species build exists to answer.
  drawDexRow(g, model);

  // Row 5: WEEK usage bar
  g.font = `800 12px ${MONO}`;
  g.fillText("WEEK", 11, 188);
  drawMeter(g, 56, 175, 92, 16, clampPct(model.pweek), { striped: true });
  g.font = `800 14px ${MONO}`;
  g.textAlign = "right";
  g.fillText(text.pweek === "--" ? "--" : `${text.pweek}%`, LEFT_W - 12, 190);
  g.textAlign = "left";

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

// Left-panel rows 3 and 4, in the band the layout has kept blank since the
// panel was first drawn: below the date/weekday row (baseline 88) and above the
// WEEK meter (top 175).
export const DATE_PX = 21;      // 1.5x the original 14
export const WEEKDAY_PX = 14;   // see drawLeftPanel: 21 here overflows the row
export const DATE_ROW_LEFT = 11;
export const DATE_ROW_RIGHT = LEFT_W - 12;

const ENC_ROW_Y = 100;      // top of the message row; its baseline is +20
const DEX_ROW_Y = 155;      // text baseline, 20px clear of the WEEK meter above it
const PANEL_LEFT = 10;      // matches the separator lines and the 11px text margin
const PANEL_RIGHT = LEFT_W - 12;

// The row never goes blank and the text never moves; only the stroke weight
// alternates. Two reasons it is done this way rather than by inverting a box:
// the species must NOT be given away before the capture screen shows it, and a
// row that blinks to blank can be missed entirely by glancing during the off
// half -- an offer only lasts offerMs.
export const ENCOUNTER_BLINK_PERIOD = 6;   // animator frames (333ms each) -- 1s heavy, 1s light

export const ENCOUNTER_TEXT = "有野生宝可梦出现";
export const PLACE_TEXT = {
  work: "工作要耐心礼貌哦",
  home: "在家要好好休息哦",
};

export function encounterBlinkOn(animPhase) {
  if (!Number.isInteger(animPhase)) return true;   // a still frame shows the heavy one
  return animPhase % ENCOUNTER_BLINK_PERIOD < ENCOUNTER_BLINK_PERIOD / 2;
}

// Centred, because it is a message rather than a field -- everything else in
// this panel is a label paired with a value and hangs off one margin or the
// other, and this row is neither.
function drawCentred(g, text, y) {
  g.fillText(text, Math.round(PANEL_LEFT + (PANEL_RIGHT - PANEL_LEFT - g.measureText(text).width) / 2), y);
}

function drawEncounterRow(g, model) {
  // An unknown place draws nothing at all. Guessing is worse than silence here:
  // the wrong guess tells him to rest at home while he is sitting at his desk.
  const idle = PLACE_TEXT[model.place] ?? null;
  const wild = Boolean(model.encounter?.species);
  if (!wild && !idle) return;

  const heavy = wild ? encounterBlinkOn(model.buddy?.animPhase) : true;
  g.fillStyle = INK;
  // 14px, the same approved size the rest of the panel's prose uses. Zpix only
  // has two effective weights -- everything at or below 600 renders identically,
  // as does everything at or above 700 -- and both advance the same width, which
  // is what lets this blink without the text shifting sideways.
  g.font = `${heavy ? 800 : 400} 14px ${CJK}`;
  drawCentred(g, wild ? ENCOUNTER_TEXT : idle, ENC_ROW_Y + 20);
}

// 图鉴 counts distinct species (the collection), 捕捉 counts throws that landed
// (duplicates included). They are deliberately different numbers -- see
// dexProgress() -- so they are labelled rather than run together.
function drawDexRow(g, model) {
  const dex = model.dex;
  if (!dex) return;

  g.fillStyle = INK;
  g.font = `800 12px ${CJK}`;
  g.fillText(`图鉴 ${dex.dexCaught}/${dex.dexTotal}`, 11, DEX_ROW_Y);
  g.textAlign = "right";
  g.fillText(`捕捉 ${dex.capturedCount}`, PANEL_RIGHT, DEX_ROW_Y);
  g.textAlign = "left";
}

// Row y-coordinates for the right (buddy) panel, top to bottom:
// 1. level + exp bar + streak, all on one line  2. mood indicator (left) +
// status bubble (right), mirrored to opposite edges  [sprite, sitting below
// row 2]  3. buddy name + species line  4. 亲密度 hearts (unchanged position)
const BUDDY_ROW1_Y = 26;   // shared text baseline for Lv/level/streak/天
const BUDDY_ROW3_Y = 52;   // mood square top / bubble top -- the gap between row 1 and the sprite
const BUDDY_ROW4_Y = 274;  // name+species line baseline -- close to the 亲密度 row (284/296), no dead gap

function drawBuddyPanel(g, model) {
  const panelX = LEFT_W;
  const panelW = W - LEFT_W;
  const buddy = model.buddy ?? {};
  const hasAnimPhase = Number.isInteger(buddy.animPhase); // 缺省 → bob=0 且不画 accent（既有渲染零变化）
  const phase = hasAnimPhase ? buddy.animPhase : 0;
  const bob = BUDDY_BOB[phase % BUDDY_BOB.length];
  const hop = Number.isInteger(buddy.hop) ? buddy.hop : 0;

  const level = Math.max(1, Number(buddy.level ?? 1));
  // Today's hearts when the model carries them; the lifetime-bond mapping stays as
  // the fallback so older callers (and the dashboard preview) still render.
  const hearts = Number.isFinite(buddy.bondHearts) ? buddy.bondHearts : heartCount(buddy.bond ?? 0);
  const streak = Math.max(0, Number(model.streak ?? 0));

  // Row 1: Lv + level, exp bar, streak + 天 -- one line, the bar taking whatever
  // horizontal space the two text clusters leave it.
  drawLevelExpStreakRow(g, panelX, panelW, level, streak, buddy);

  drawShadow(g, panelX + panelW / 2, 240); // 240 = original 200 shifted by the same +40 as BUDDY_SPRITE_TOP, staying under the sprite's feet
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

  // Row 3: mood indicator (left edge) and status bubble (right edge),
  // mirrored to opposite sides of the panel in the gap between the exp bar
  // and the sprite.
  drawBubble(g, W - 8, BUDDY_ROW3_Y, buddy.bubble ?? EEVEE_IDLE_CRY, { size: "small" });
  g.fillStyle = INK;
  g.font = `800 12px ${MONO}`;
  g.fillRect(panelX + 14, BUDDY_ROW3_Y + 11, 7, 7); // +11 vertically centers the 7px square against the bubble's 28px height
  g.fillText(MOOD_ZH[buddy.mood] ?? buddy.mood ?? "专注", panelX + 25, BUDDY_ROW3_Y + 19);

  // Row 4: buddy name + species
  drawSpeciesLine(g, panelX, panelW, buddy);

  // Row 5: 亲密度 -- unchanged
  g.font = `700 12px ${CJK}`;
  g.fillText("亲密度", panelX + 14, 296);
  drawHearts(g, panelX + 58, 284, hearts);
}

// Row 1 packs three things onto one line: "Lv" + the level number on the left,
// the streak number + "天" on the right, and the EXP bar filling the gap between
// them. The two numbers carry the row at 24px while their labels sit at 12px, so
// what you read first is the pair of numbers, not the words around them. Both
// sizes are Zpix grid multiples (12/24) -- anything between renders muddy 1-bit.
const ROW1_BIG_PX = 24;
const ROW1_SMALL_PX = 12;
const ROW1_SIDE_MARGIN = 14;
const ROW1_GAP = 8;        // text cluster -> bar breathing room, both sides
const ROW1_BAR_Y = 13;     // centres the 11px bar against the 24px numerals
const ROW1_BAR_H = 11;

// Geometry is computed off a scratch context so the exact same measurements are
// available to callers that need to know where the bar landed (tests) without
// re-deriving font metrics that only @napi-rs/canvas can answer.
const measureCtx = createCanvas(1, 1).getContext("2d");

export function row1Geometry(panelX, panelW, level, streak) {
  const g = measureCtx;
  g.font = `800 ${ROW1_SMALL_PX}px ${MONO}`;
  const lvW = Math.ceil(g.measureText("Lv").width);
  g.font = `800 ${ROW1_BIG_PX}px ${MONO}`;
  const levelText = String(level);
  const streakText = String(streak);
  const levelW = Math.ceil(g.measureText(levelText).width);
  const streakW = Math.ceil(g.measureText(streakText).width);
  g.font = `800 ${ROW1_SMALL_PX}px ${CJK}`;
  const dayW = Math.ceil(g.measureText("天").width);

  const lvX = panelX + ROW1_SIDE_MARGIN;
  const levelX = lvX + lvW;
  const barX = levelX + levelW + ROW1_GAP;
  const streakX = panelX + panelW - ROW1_SIDE_MARGIN - dayW - streakW;
  const dayX = streakX + streakW;
  return {
    lvX, levelX, levelText, streakX, streakText, dayX,
    barX,
    barW: Math.max(0, streakX - ROW1_GAP - barX),
    barY: ROW1_BAR_Y,
    barH: ROW1_BAR_H,
  };
}

function drawLevelExpStreakRow(g, panelX, panelW, level, streak, buddy) {
  const geo = row1Geometry(panelX, panelW, level, streak);
  g.fillStyle = INK;
  g.textAlign = "left";

  g.font = `800 ${ROW1_SMALL_PX}px ${MONO}`;
  g.fillText("Lv", geo.lvX, BUDDY_ROW1_Y);
  g.font = `800 ${ROW1_BIG_PX}px ${MONO}`;
  g.fillText(geo.levelText, geo.levelX, BUDDY_ROW1_Y);

  if (geo.barW > 0) drawExpBar(g, geo.barX, geo.barY, geo.barW, geo.barH, buddy);

  g.font = `800 ${ROW1_BIG_PX}px ${MONO}`;
  g.fillText(geo.streakText, geo.streakX, BUDDY_ROW1_Y);
  g.font = `800 ${ROW1_SMALL_PX}px ${CJK}`;
  g.fillText("天", geo.dayX, BUDDY_ROW1_Y);
  g.fillStyle = INK;
}

function drawSpeciesLine(g, panelX, panelW, buddy) {
  const cx = panelX + panelW / 2;
  g.font = `800 12px ${CJK}`;
  g.textAlign = "left"; // Zpix 12px 过 1-bit 需整数左边缘, 自算 center 再 round (避免半像素碎裂)
  const centered = (t) => g.fillText(t, Math.round(cx - g.measureText(t).width / 2), BUDDY_ROW4_Y);
  if (buddy.readyToEvolve) {
    g.fillStyle = INK;
    g.fillRect(panelX + 18, BUDDY_ROW4_Y - 14, panelW - 36, 18);
    g.fillStyle = PAPER;
    centered("▲ 按 KEY 进化！");
  } else {
    g.fillStyle = INK;
    centered(displayName(buddy.name, buddy.species));
  }
  g.fillStyle = INK;
}

export function fitTodayLineFont(g, text) {
  return fitFont(g, text, {
    ...TODAY_FONT,
    maxWidth: TODAY_TEXT_MAX_X - TODAY_TEXT_X,
  });
}

// One continuous black fill growing left to right -- no day cells, no ticks. How
// long a level takes is deliberately not readable off the bar; all it says is how
// far along this one you are.
function drawExpBar(g, x, y, w, h, buddy = {}) {
  drawMeter(g, x, y, w, h, clampPct(buddy.expPct ?? 0), { striped: false });
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

// size "normal" is the original full-size bubble (unused now but kept for
// callers that want it); "small" is a reduced size -- bigger than a first
// attempt at "shrunk" turned out to be (illegibly tiny), smaller than
// "normal" (owner-tuned: a bit smaller than original, clearly legible).
const BUBBLE_SIZES = {
  normal: { fontPx: 24, height: 36, padX: 11, radius: 9, lineWidth: 2 },
  small: { fontPx: 18, height: 28, padX: 9, radius: 7, lineWidth: 1 },
};

// Returns the bubble's left edge x -- callers position adjacent elements
// (e.g. the mood indicator) relative to it without duplicating this math.
function drawBubble(g, rightX, y, text, { size = "normal" } = {}) {
  const { fontPx, height, padX, radius, lineWidth } = BUBBLE_SIZES[size];
  g.font = `700 ${fontPx}px ${MONO}`;
  const w = Math.ceil(g.measureText(text).width) + padX * 2;
  const x = rightX - w;
  g.fillStyle = PAPER;
  g.strokeStyle = INK;
  g.lineWidth = lineWidth;
  roundedRect(g, x, y, w, height, radius);
  g.fill();
  g.stroke();
  g.fillStyle = INK;
  g.fillText(text, x + padX, y + Math.round(height * 0.75));
  g.lineWidth = 2; // restore the panel-wide default other drawing relies on
  return x;
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

function drawHearts(g, x, y, filled) {
  for (let i = 0; i < 5; i += 1) {
    drawHeart(g, x + i * 20, y, Math.max(0, Math.min(1, filled - i)));
  }
}

// heartPath spans x .. x+16 horizontally (its outermost bezier controls sit at
// x and x+16) and y+1 .. y+13 vertically. The partial fill has to be measured
// against that full width: it used 8, i.e. half of it, so a half heart filled
// about 15% of the shape and read on the panel as "a sliver went dark" rather
// than "half a heart". Nothing throws when this is wrong -- the fill is a
// clipped rect, so it just quietly under-fills.
const HEART_W = 16;
const HEART_H = 14;

export function drawHeart(g, x, y, fill) {
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
    g.fillRect(x, y, Math.round(HEART_W * fill), HEART_H);
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

// Small battery glyph (outline + nub + up to 4 filled segments), left-
// anchored at `x` (top-left corner, where the "CLAUDE" label used to sit --
// the clock text is right-aligned on the opposite side of the row, so
// there's no collision to guard against here).
// No numeric percent is drawn -- only which of the 4 quarters are lit.
// Below BATTERY_CRITICAL_PCT it blinks: `animPhase` is the buddy animator's
// free-running counter (increments every ~333ms independent of the main
// 60s tick, see buddy-animator.js), so this needs no timer of its own --
// every other ~666ms half-cycle the whole icon is simply not drawn.
// Every element here is drawn with fillRect, never stroke()/strokeRect --
// confirmed on real hardware that a 1px stroked path (which straddles its
// coordinate, e.g. a line at x=10 actually paints x=9.5..10.5) anti-aliases
// into two half-covered pixel columns that read as gray and vanish under
// this project's 1-bit thresholding. It looked fine in an RGBA preview PNG
// and was still missing on the device -- fillRect at integer coordinates
// is the only shape guaranteed to survive threshold with no ambiguity.
function fillRectOutline(g, x, y, w, h) {
  g.fillRect(x, y, w, 1);
  g.fillRect(x, y + h - 1, w, 1);
  g.fillRect(x, y, 1, h);
  g.fillRect(x + w - 1, y, 1, h);
}

// Each of the 4 segments is its own bordered box -- filled solid if lit,
// outline-only if not -- so the "4 segments" structure is always visible
// regardless of charge level. A single continuous fill bar (the previous
// attempt) merges adjacent lit segments into one blob with no internal
// structure, and an unlit segment with no border at all is indistinguishable
// from blank icon background -- both are what this fixes.
function drawBatteryIndicator(g, x, pct, animPhase) {
  const clamped = Math.max(0, Math.min(100, pct));
  const blinkedOut = clamped < BATTERY_CRITICAL_PCT && Math.floor((animPhase ?? 0) / 2) % 2 === 1;
  if (blinkedOut) return;

  // iconW picked so innerW (iconW-4) minus the 3 inter-segment gaps divides
  // evenly by 4 -- (23-3)/4 = 5 exactly. A non-integer segW here previously
  // caused Math.round() to accumulate rounding error across segments and
  // silently erase the gap before the last segment (confirmed reproducible
  // on real hardware: same divider missing every time, not random -- which
  // is what pinned this down as rounding, not a stale-frame/timing issue).
  const iconW = 27;
  const iconH = 10;
  const nubW = 2;
  const segGap = 1;
  const iconX = x;
  const iconY = 11;

  g.save();
  g.fillStyle = INK;
  fillRectOutline(g, iconX, iconY, iconW, iconH);
  g.fillRect(iconX + iconW, iconY + (iconH - 4) / 2, nubW, 4);

  const innerX = iconX + 2;
  const innerY = iconY + 2;
  const innerW = iconW - 4; // 23
  const innerH = iconH - 4;
  const segW = (innerW - segGap * (BATTERY_SEGMENTS - 1)) / BATTERY_SEGMENTS; // exactly 5, no rounding needed
  if (!Number.isInteger(segW)) throw new Error(`battery icon segment math must divide evenly, got ${segW}`);

  const litSegments = Math.round((clamped / 100) * BATTERY_SEGMENTS);
  for (let i = 0; i < BATTERY_SEGMENTS; i++) {
    const sx = innerX + i * (segW + segGap);
    if (i < litSegments) {
      g.fillRect(sx, innerY, segW, innerH);
    } else {
      fillRectOutline(g, sx, innerY, segW, innerH);
    }
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
