import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeUsage } from "../src/index.js";

test("rate-limits 覆盖百分比/reset, ccusage 保留 cost/token", () => {
  const cc = { p5h: null, pweek: null, resets5h: null, resetsWeek: null, todayCost: 183.8, todayTokens: 186_000_000, modelled: false };
  const rl = { p5h: 9, pweek: 52, resets5h: "2026-06-09T14:09:59.000Z", resetsWeek: "2026-06-14T02:00:00.000Z", official: true, stale: false };
  const u = mergeUsage(cc, rl);
  assert.equal(u.p5h, 9);
  assert.equal(u.pweek, 52);
  assert.equal(u.resets5h, "2026-06-09T14:09:59.000Z");
  assert.equal(u.todayCost, 183.8);
  assert.equal(u.todayTokens, 186_000_000);
  assert.equal(u.official, true);
});

test("rate-limits 缺失时百分比为 null（UI 显示 --），cost/token 仍在", () => {
  const cc = { todayCost: 12.3, todayTokens: 1000, p5h: null, pweek: null };
  const rl = { p5h: null, pweek: null, resets5h: null, resetsWeek: null, official: false, stale: true };
  const u = mergeUsage(cc, rl);
  assert.equal(u.p5h, null);
  assert.equal(u.official, false);
  assert.equal(u.todayCost, 12.3);
});

test("token 用量再大也不会被换算成百分比顶上去（估算值会永远顶到 100%）", () => {
  const cc = { activeTokens: 23_766_653, weekTokens: 43_000_000, todayCost: 4 };
  const rl = { p5h: null, pweek: null, resets5h: null, resetsWeek: null, official: false, stale: true };
  const u = mergeUsage(cc, rl);

  assert.equal(u.p5h, null);
  assert.equal(u.pweek, null);
  assert.equal(u.official, false);
});
