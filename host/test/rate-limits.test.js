import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRateLimits } from "../src/rate-limits.js";

function fixture(obj) {
  const dir = mkdtempSync(join(tmpdir(), "cpb-rl-"));
  const path = join(dir, "cpb-usage.json");
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

const NOW = 1_750_000_000_000; // 固定基准（ms）
const NOW_SEC = Math.floor(NOW / 1000);
const STALE_ALL_NULL = { p5h: null, pweek: null, resets5h: null, resetsWeek: null, official: false, stale: true };

test("parses official 5h/week percent and converts epoch reset to ISO", () => {
  const path = fixture({
    fiveHourPct: 9, fiveHourReset: NOW_SEC + 3600,
    weeklyPct: 52, weeklyReset: NOW_SEC + 86400,
    writtenAt: NOW_SEC,
  });
  const rl = loadRateLimits({ path, now: NOW });
  assert.equal(rl.p5h, 9);
  assert.equal(rl.pweek, 52);
  assert.equal(rl.resets5h, new Date((NOW_SEC + 3600) * 1000).toISOString());
  assert.equal(rl.resetsWeek, new Date((NOW_SEC + 86400) * 1000).toISOString());
  assert.equal(rl.official, true);
  assert.equal(rl.stale, false);
});

test("missing file → all null, not stale-crash", () => {
  const rl = loadRateLimits({ path: "/no/such/cpb-usage.json", now: NOW });
  assert.equal(rl.p5h, null);
  assert.equal(rl.pweek, null);
  assert.equal(rl.resets5h, null);
  assert.equal(rl.official, false);
});

test("missing five_hour field → p5h null but weekly still parsed", () => {
  const path = fixture({ weeklyPct: 52, weeklyReset: NOW_SEC + 10, writtenAt: NOW_SEC });
  const rl = loadRateLimits({ path, now: NOW });
  assert.equal(rl.p5h, null);
  assert.equal(rl.pweek, 52);
  assert.equal(rl.official, true); // 有任一即 official
});

test("written over 15min ago → stale=true", () => {
  const path = fixture({ fiveHourPct: 9, writtenAt: NOW_SEC - 16 * 60 });
  const rl = loadRateLimits({ path, now: NOW });
  assert.equal(rl.stale, true);
});

test("out-of-range fiveHourReset returns null reset without throwing", () => {
  const path = fixture({ fiveHourReset: 1e18, writtenAt: NOW_SEC });
  let rl;
  assert.doesNotThrow(() => {
    rl = loadRateLimits({ path, now: NOW });
  });
  assert.equal(rl.resets5h, null);
});

test("poisoned non-object usage payload returns stale all-null shape without throwing", () => {
  for (const payload of [null, 5, "x", []]) {
    const path = fixture(payload);
    let rl;
    assert.doesNotThrow(() => {
      rl = loadRateLimits({ path, now: NOW });
    });
    assert.deepEqual(rl, STALE_ALL_NULL);
  }
});

test("millisecond-sized reset epoch returns null reset without throwing", () => {
  const path = fixture({ fiveHourReset: 8_640_000_000_001, writtenAt: NOW_SEC });
  let rl;
  assert.doesNotThrow(() => {
    rl = loadRateLimits({ path, now: NOW });
  });
  assert.equal(rl.resets5h, null);
});

test("loadRateLimits drops a reading whose window has certainly rolled over", () => {
  const sixHours = fixture({ fiveHourPct: 55, weeklyPct: 13, writtenAt: NOW_SEC - 6 * 60 * 60 });
  const a = loadRateLimits({ path: sixHours, now: NOW_SEC * 1000 });
  assert.equal(a.p5h, null);
  assert.equal(a.pweek, 13);
  assert.equal(a.stale, true);

  const twoDays = fixture({ fiveHourPct: 55, weeklyPct: 13, writtenAt: NOW_SEC - 48 * 60 * 60 });
  const b = loadRateLimits({ path: twoDays, now: NOW_SEC * 1000 });
  assert.equal(b.p5h, null);
  assert.equal(b.pweek, null);
  assert.equal(b.official, false);
});
