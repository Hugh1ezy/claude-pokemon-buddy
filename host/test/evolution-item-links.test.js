import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eligibleBranches, resolveEvolution } from "../src/pet/evolution.js";

// Generation 1 gated twenty links behind a stone or a trade. This device has
// neither, so each one was given a condition it can actually meet instead.
//
// What those conditions ARE is deliberately not in this file, and must not be
// put here: the owner reads the tests, and finding out by playing is the point.
// So everything below asserts a PROPERTY of the substitute table -- that it
// covers every link, that nothing in it is unreachable, that nothing in it is
// shadowed -- and never a value. Each of these has already been violated in
// this directory at least once.
const LINKS = JSON.parse(readFileSync(new URL("../seed/evolution-item-links.json", import.meta.url), "utf8"));
const GENERATED = JSON.parse(readFileSync(new URL("../seed/evolution/_generated.json", import.meta.url), "utf8"));

// Everything true at once, so a branch is eligible unless a condition actively
// excludes it. `weatherKind` holds one value at a time, so "eligible at all"
// means eligible under one of them -- hence WEATHERS and `reachable` below.
const ANYTHING = {
  level: 100,
  bond: 180,
  streak: 60,
  careCount: 30,
  care: true,
  daytime: true,
  night: true,
  warmHumid: true,
  cold: true,
  weatherKind: null,
};

// Every value weather.js resolves from a WMO code, plus the no-reading case.
const WEATHERS = [null, "sun", "rain", "fog"];

function reachable(link, ctx) {
  return WEATHERS.some((weatherKind) =>
    eligibleBranches(link.from, { ...ctx, weatherKind }).some((b) => b.to === link.to),
  );
}

// What the owner can reach by DECIDING to: no weather, no evening, no streak.
const BY_DECIDING = {
  ...ANYTHING,
  streak: 0,
  night: false,
  warmHumid: false,
  cold: false,
};

test("every Gen-1 item and trade link has somewhere to go", () => {
  const orphans = LINKS.filter((link) => !reachable(link, ANYTHING));

  assert.deepEqual(orphans, [], "a link with no branch is a pokemon that can never evolve");
});

test("no item link is gated behind weather the owner cannot arrange", () => {
  // The one exception is a species with a CHOICE of targets: picking which one
  // is the feature there, so an individual target may want its own conditions
  // as long as the species keeps a road that needs none.
  const multiTarget = new Set(
    LINKS.map((l) => l.from).filter((from, i, all) => all.indexOf(from) !== all.lastIndexOf(from)),
  );

  const stranded = LINKS
    .filter((link) => !multiTarget.has(link.from))
    .filter((link) => !eligibleBranches(link.from, BY_DECIDING).some((b) => b.to === link.to));
  // BY_DECIDING deliberately keeps weatherKind null: a road that needs a reading
  // is a road the owner has to wait for, which is what this test exists to catch.

  assert.deepEqual(stranded, [], "these can only evolve if the weather cooperates");

  for (const from of multiTarget) {
    assert.ok(
      eligibleBranches(from, BY_DECIDING).length > 0,
      `${from} has a choice of targets but no road that needs nothing`,
    );
  }
});

test("nothing is gated on a cold snap this city does not have", () => {
  // `cold` is temp <= 4. eevee's own glaceon branch is the owner's file and his
  // call; nothing generated may join it.
  const table = JSON.parse(readFileSync(new URL("../seed/evolution/_special.json", import.meta.url), "utf8"));
  const frozen = Object.entries(table)
    .filter(([, node]) => (node.branches ?? []).some((b) => b.needs?.cold != null))
    .map(([species]) => species);

  assert.deepEqual(frozen, []);
});

test("every numeric need is one needsMet reads as a floor", () => {
  // `needsMet` compares anything outside THRESHOLDS with ===, so a number on any
  // other key would mean EXACTLY that value and would be open for one tick in
  // its life. This is the single most expensive mistake available in this table.
  const THRESHOLDS = new Set(["bond", "level", "streak", "careCount"]);
  const table = JSON.parse(readFileSync(new URL("../seed/evolution/_special.json", import.meta.url), "utf8"));

  for (const [species, node] of Object.entries(table)) {
    for (const branch of node.branches ?? []) {
      for (const [need, value] of Object.entries(branch.needs)) {
        if (typeof value !== "number") continue;
        assert.ok(THRESHOLDS.has(need), `${species}: ${need} carries a number but is compared with ===`);
      }
    }
  }
});

test("no substitute is shadowed by the canonical table", () => {
  // Two roads to one place that nobody designed together: the canonical branch
  // wins on load order and the substitute is dead with no symptom. Measured
  // 2026-09-04, after one had been dead in the table for a month.
  const doubled = LINKS.filter((link) =>
    (GENERATED[link.from]?.branches ?? []).some((b) => b.to === link.to),
  );

  assert.deepEqual(doubled, []);
});

test("an item line evolves on KEY rather than stalling on a silent choice", () => {
  // A species whose eligible branches all name one target has nothing to choose
  // between. If `auto` were null there, KEY would do nothing and the dashboard
  // would offer two buttons with the same word on them.
  const singleTarget = [...new Set(LINKS.map((l) => l.from))].filter(
    (from) => LINKS.filter((l) => l.from === from).length === 1,
  );

  for (const from of singleTarget) {
    const resolved = resolveEvolution(from, ANYTHING);
    assert.ok(resolved.auto, `${from} is ready to evolve but KEY has nothing to act on`);
  }
});
