import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const USAGE_PATH = join(homedir(), ".claude", "cpb-usage.json");
const STALE_SEC = 15 * 60; // 没用 CC 超过 15min → stale
// Past these ages a reading is not "stale", it is about a window that has since
// rolled over, and showing it is showing a number about nothing. Measured
// 2026-10-13: with no feed on the machine the panel had been displaying one
// 55% / 13% from 07-27 for eleven weeks. "--" is the honest value by then.
const FIVE_HOUR_EXPIRE_SEC = 5 * 60 * 60;
const WEEK_EXPIRE_SEC = 24 * 60 * 60;

export function loadRateLimits({ path = USAGE_PATH, now = Date.now() } = {}) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return staleAllNull();
  }
  if (!isPlainObject(data)) return staleAllNull();
  try {
    const writtenAt = Number(data.writtenAt);
    const age = Number.isFinite(writtenAt) ? Math.floor(now / 1000) - writtenAt : Infinity;
    const stale = age > STALE_SEC;
    const p5h = age > FIVE_HOUR_EXPIRE_SEC ? null : numOrNull(data.fiveHourPct);
    const pweek = age > WEEK_EXPIRE_SEC ? null : numOrNull(data.weeklyPct);
    return {
      p5h,
      pweek,
      resets5h: epochToIso(data.fiveHourReset),
      resetsWeek: epochToIso(data.weeklyReset),
      official: p5h != null || pweek != null,
      stale,
    };
  } catch {
    return staleAllNull();
  }
}

function staleAllNull() {
  return { p5h: null, pweek: null, resets5h: null, resetsWeek: null, official: false, stale: true };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function epochToIso(sec) {
  return Number.isFinite(sec) && Math.abs(sec) < 8.64e12 ? new Date(sec * 1000).toISOString() : null;
}
