import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";

import { fitTodayLineFont, formatReset, heartCount, layoutText, weatherIconKind } from "../src/render/layout.js";
import { renderFrame } from "../src/render/frame.js";
import { LEFT_W } from "../src/render/palette.js";

test("layout text includes wind in the weather detail row", () => {
  const text = layoutText({
    clock: "09:14",
    p5h: 72,
    pweek: 41,
    resets5h: "resets in 2h",
    resetsWeek: "wk resets Jun 2",
    todayCost: 4.1,
    todayTokens: 5_300_000,
    weather: {
      cond: "多云",
      temp: 19,
      feels: 17,
      hi: 22,
      lo: 14,
      precip: 30,
      wind: 11,
    },
  });

  assert.match(text.weatherDetail, /风速11/);
});

test("layout text formats clock and reset ISO values", () => {
  const now = new Date(2026, 4, 30, 10, 0);
  const text = layoutText({
    now,
    resets5h: new Date(2026, 4, 30, 12, 14).toISOString(),
    resetsWeek: new Date(2026, 5, 2, 15, 45).toISOString(),
  });

  assert.equal(text.clock, "10:00");
  assert.equal(text.resets5h, "in 2h14m");
  assert.equal(text.resetsWeek, "Jun 02, 15:45");
  assert.doesNotMatch(text.resets5h, /2026-/);
  assert.doesNotMatch(text.resetsWeek, /2026-/);
});

test("formatReset handles short, cross-day, later, and empty reset values", () => {
  const now = new Date(2026, 4, 30, 10, 0);

  assert.equal(formatReset(new Date(2026, 4, 30, 10, 42).toISOString(), now), "in 42m");
  assert.equal(formatReset(new Date(2026, 4, 31, 0, 15).toISOString(), new Date(2026, 4, 30, 23, 30)), "tomorrow 00:15");
  assert.equal(formatReset(new Date(2026, 5, 2, 15, 45).toISOString(), now), "Jun 02, 15:45");
  assert.equal(formatReset(null, now), "reset unknown");
});

test("weather text keeps feels and wind mapped to the correct fields", () => {
  const text = layoutText({
    weather: {
      cond: "雨",
      temp: 19,
      feels: 17,
      hi: 22,
      lo: 14,
      precip: 30,
      wind: 11,
    },
  });

  assert.equal(text.weatherMain, "雨 19°");
  assert.equal(text.weatherFeels, "体感17°");
  assert.equal(text.weatherDetail, "高22°低14° 降雨概率30% 风速11");
  assert.doesNotMatch(text.weatherMain, /风/);
});

test("weather icon kind follows the current condition", () => {
  assert.equal(weatherIconKind({ cond: "晴" }), "sun");
  assert.equal(weatherIconKind({ cond: "多云" }), "cloud");
  assert.equal(weatherIconKind({ cond: "雨" }), "rain");
  assert.equal(weatherIconKind({ cond: "雪" }), "snow");
  assert.equal(weatherIconKind({ cond: "雾" }), "fog");
});

test("heartCount maps raw bond to 0-5 in half-heart steps", () => {
  assert.equal(heartCount(0), 0);
  assert.equal(heartCount(40), 1);
  assert.equal(heartCount(60), 1.5);
  assert.equal(heartCount(180), 5);
  assert.equal(heartCount(9999), 5);
});

test("layout draws hearts without platform heart glyphs", () => {
  const source = readFileSync(new URL("../src/render/layout.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /[♥♡]/);
});

test("today usage line renders 14px when it fits, 12px fallback when overlong", () => {
  const g = createCanvas(400, 300).getContext("2d");

  const typical = layoutText({
    todayCost: 598.35,
    todayTokens: 400_600_000,
  });
  g.font = fitTodayLineFont(g, typical.today);
  assert.match(g.font, /14px "Zpix"/);
  assert.ok(g.measureText(typical.today).width <= LEFT_W - 23);

  const overlong = "今日 $999,999,999.99·999,999,999,999 tokens";
  g.font = fitTodayLineFont(g, overlong);
  assert.match(g.font, /12px "Zpix"/);
});

test("today line keeps one decimal in every compact token bucket", () => {
  assert.equal(
    layoutText({ todayCost: 598.35, todayTokens: 400_600_000 }).today,
    "今日 $598·400.6M",
  );
  assert.equal(
    layoutText({ todayCost: 12, todayTokens: 453_200 }).today,
    "今日 $12·453.2K",
  );
  assert.equal(
    layoutText({ todayCost: 12, todayTokens: 1_234_000_000 }).today,
    "今日 $12·1.2B",
  );
});

test("layout uses the registered Zpix pixel font at approved sizes only", () => {
  const source = readFileSync(new URL("../src/render/layout.js", import.meta.url), "utf8");
  const staticFontSizes = [...source.matchAll(/g\.font = `[^`]*?(\d+)px \$\{(?:MONO|CJK)\}`/g)]
    .map((match) => Number(match[1]));
  // 12/24/48 = Zpix 整数倍；14 = 2026-07-07 视觉伴侣选型定稿（说明行，真机渲染验收过）。
  const approved = new Set([12, 14, 24, 48]);

  assert.match(source, /GlobalFonts\.registerFromPath/);
  assert.doesNotMatch(source, /Courier New|PingFang|Hiragino|Microsoft YaHei/);
  assert.ok(staticFontSizes.length > 0);
  assert.deepEqual(staticFontSizes.filter((size) => !approved.has(size)), []);
});

test("layout text uses degraded labels instead of fake reset data", () => {
  const text = layoutText({
    now: new Date(2026, 4, 30, 9, 5),
    degraded: true,
    p5h: null,
    pweek: null,
    resets5h: null,
    resetsWeek: null,
    todayCost: null,
    todayTokens: null,
    weather: { degraded: true },
  });

  assert.equal(text.clock, "09:05");
  assert.equal(text.p5h, "--");
  assert.equal(text.pweek, "--");
  assert.equal(text.resets5h, "reset unknown");
  assert.equal(text.resetsWeek, "reset unknown");
  assert.equal(text.today, "今日 $--·--");
  assert.match(text.weatherMain, /degraded/);
  assert.match(text.weatherMain, /--°/);
  assert.match(text.weatherDetail, /风速--/);
});

test("layoutText flags stale rate-limit data via rateNote", () => {
  assert.equal(layoutText({ p5h: 72, pweek: 41, rateStale: true }).rateNote, "stale");
  assert.equal(layoutText({ p5h: 72, pweek: 41, rateStale: false }).rateNote, "");
  assert.equal(layoutText({ p5h: 72, pweek: 41 }).rateNote, "");
});

test("ready-to-evolve badge differs from species-name line", async () => {
  const normal = await renderFrame(baseModel({ readyToEvolve: false }));
  const ready = await renderFrame(baseModel({ readyToEvolve: true }));
  assert.ok(!normal.pngBuffer.equals(ready.pngBuffer), "badge state must render differently");
});

test("buddy ground shadow survives the 1-bit threshold", async () => {
  const { bitmap } = await renderFrame(baseModel({
    spriteGray: new Uint8Array(40 * 40).fill(255),
    spriteW: 40,
    spriteH: 40,
  }));

  // Shadow moved from center-y 200 to 240 when the sprite shifted down to
  // make room for row 3 (mood + status bubble) above it -- see layout.js's
  // BUDDY_SPRITE_TOP comment.
  assert.ok(countOnPixels(bitmap, 250, 234, 100, 12) > 0, "shadow region must contain ink pixels");
});

function baseModel(extra) {
  return {
    p5h: 12,
    pweek: 34,
    todayCost: 1,
    now: new Date(2026, 5, 10, 14),
    weather: { cond: "多云", temp: 12, humidity: 50 },
    room: { t: 21, h: 45 },
    out: { t: 12, h: 50 },
    buddy: {
      spriteGray: new Uint8Array(40 * 40).fill(255),
      spriteW: 40,
      spriteH: 40,
      mood: "happy",
      level: 5,
      bond: 40,
      expPct: 40,
      bubble: "Bui!",
      species: "eevee",
      readyToEvolve: false,
      ...extra,
    },
  };
}

function countOnPixels(bitmap, x, y, w, h) {
  const rowBytes = Math.ceil(bitmap.w / 8);
  let count = 0;

  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      count += (bitmap.bytes[yy * rowBytes + (xx >> 3)] >> (7 - (xx & 7))) & 1;
    }
  }

  return count;
}
