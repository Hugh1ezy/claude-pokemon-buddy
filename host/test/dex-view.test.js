import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEX_IDLE_TICKS_BEFORE_CLOSE,
  ageDexView,
  isDexOpenGesture,
  pageForCursor,
  stepDexView,
} from "../src/pet/dex-view.js";

const press = (key, kind) => ({ key, kind });
const open = (over = {}) => ({ cursor: 0, confirming: false, idleTicks: 0, ...over });
const step = (view, event, size = 3) => stepDexView(view, event, { rosterSize: size });

test("KEY double opens it, and nothing else does", () => {
  assert.deepEqual(step(null, press("KEY", "double")).view, open());

  for (const event of [
    press("KEY", "short"), press("KEY", "long"), press("KEY", "down"),
    press("BOOT", "double"), press("BOOT", "short"), null, undefined, {},
  ]) {
    assert.equal(step(null, event).view, null, `${JSON.stringify(event)} must not open it`);
  }
});

// BOOT is power-save's alone. Borrowing it is what stopped the radio on 07-27,
// and the symptom read as dead hardware rather than as a button conflict.
test("BOOT never does anything, in any state", () => {
  for (const kind of ["short", "long", "double"]) {
    assert.deepEqual(step(open(), press("BOOT", kind)).view, open());
    assert.deepEqual(step(open({ confirming: true }), press("BOOT", kind)).view, open({ confirming: true }));
    assert.equal(step(null, press("BOOT", kind)).view, null);
  }
});

// The cursor walks the ROSTER, not the 151 cells: stepping cell by cell would
// be 151 presses to reach the end, and all but a handful of stops would be a
// silhouette that cannot be picked anyway.
test("a short press moves the cursor along the roster and wraps", () => {
  let view = open();
  view = step(view, press("KEY", "short")).view;
  assert.equal(view.cursor, 1);
  view = step(view, press("KEY", "short")).view;
  assert.equal(view.cursor, 2);
  view = step(view, press("KEY", "short")).view;
  assert.equal(view.cursor, 0, "the last entry wraps to the first");
});

test("a roster of one never moves the cursor off itself", () => {
  assert.equal(step(open(), press("KEY", "short"), 1).view.cursor, 0);
  assert.equal(step(open(), press("KEY", "short"), 0).view.cursor, 0, "an empty roster must not divide by zero");
});

test("a double press opens the confirm screen without swapping anything yet", () => {
  const { view, action } = step(open({ cursor: 2 }), press("KEY", "double"));
  assert.equal(view.confirming, true);
  assert.equal(view.cursor, 2, "confirming must be about the entry under the cursor");
  assert.equal(action, null, "opening the confirm screen is not itself a swap");
});

// The swap is the one irreversible thing in here, so it takes the deliberate
// gesture and the easy one backs out.
test("on the confirm screen, double swaps and short cancels", () => {
  const confirming = open({ cursor: 1, confirming: true });

  const yes = step(confirming, press("KEY", "double"));
  assert.equal(yes.action, "swap");
  assert.equal(yes.view.confirming, false, "it returns to the grid after confirming");

  const no = step(confirming, press("KEY", "short"));
  assert.equal(no.action, null);
  assert.equal(no.view.confirming, false);
  assert.equal(no.view.cursor, 1, "cancelling must not move the cursor");
});

test("a long press closes the screen from either state, and never swaps", () => {
  assert.deepEqual(step(open({ cursor: 2 }), press("KEY", "long")), { view: null, action: null });
  assert.deepEqual(step(open({ confirming: true }), press("KEY", "long")), { view: null, action: null });
});

test("it closes itself after a stretch of no input", () => {
  let view = open({ cursor: 1 });
  for (let i = 1; i < DEX_IDLE_TICKS_BEFORE_CLOSE; i += 1) {
    view = ageDexView(view);
    assert.notEqual(view, null, `still open after ${i} idle tick(s)`);
  }
  assert.equal(ageDexView(view), null, "the last idle tick closes it");
  assert.equal(ageDexView(null), null, "ageing a closed screen is a no-op");
});

// Otherwise reading the pokedex for a few minutes closes it under you.
test("any press resets the idle countdown", () => {
  const stale = open({ idleTicks: DEX_IDLE_TICKS_BEFORE_CLOSE - 1 });
  assert.equal(step(stale, press("KEY", "short")).view.idleTicks, 0);
  assert.equal(step(stale, press("KEY", "double")).view.idleTicks, 0);
});

test("the open gesture is recognised on its own, for the dispatcher's benefit", () => {
  assert.equal(isDexOpenGesture(press("KEY", "double")), true);
  assert.equal(isDexOpenGesture(press("KEY", "short")), false);
  assert.equal(isDexOpenGesture(press("BOOT", "double")), false);
  assert.equal(isDexOpenGesture(undefined), false);
});

// The page is derived from where the cursor is rather than stored beside it, so
// the two cannot disagree about which page the cursor is on.
test("the page follows the cursor rather than being turned separately", () => {
  const roster = [{ species: "a" }, { species: "b" }, { species: "c" }];
  const dexIndexOf = (species) => ({ a: 0, b: 59, c: 60 })[species];

  assert.equal(pageForCursor(open({ cursor: 0 }), roster, 60, dexIndexOf), 0);
  assert.equal(pageForCursor(open({ cursor: 1 }), roster, 60, dexIndexOf), 0, "entry 60 is still page 1");
  assert.equal(pageForCursor(open({ cursor: 2 }), roster, 60, dexIndexOf), 1, "entry 61 starts page 2");
  assert.equal(pageForCursor(open({ cursor: 9 }), roster, 60, dexIndexOf), 0, "a cursor past the roster falls back");
});
