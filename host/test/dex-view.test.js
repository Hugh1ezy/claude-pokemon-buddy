import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEX_IDLE_TICKS_BEFORE_CLOSE,
  ageDexView,
  isDexCloseGesture,
  isDexOpenGesture,
  stepDexView,
} from "../src/pet/dex-view.js";

const press = (key, kind) => ({ key, kind });
const open = (over = {}) => ({ page: 0, cursor: 0, confirming: false, idleTicks: 0, ...over });
const step = (view, event, count = 3, pages = 3) =>
  stepDexView(view, event, { pageCursorCount: count, pages });

test("KEY double opens it, and nothing else does", () => {
  assert.deepEqual(step(null, press("KEY", "double")).view, open());

  for (const event of [
    press("KEY", "short"), press("KEY", "long"), press("KEY", "down"),
    press("BOOT", "double"), press("BOOT", "short"), press("BOOT", "long"),
    null, undefined, {},
  ]) {
    assert.equal(step(null, event).view, null, `${JSON.stringify(event)} must not open it`);
  }
});

// BOOT short is the return gesture, set by the owner 2026-07-30. It is short
// and NOT double on purpose: the firmware acts on BOOT double by itself
// (enter_local_clock_mode), stopping the radio and dropping to the clock face,
// so a BOOT double here would exit the pokedex into power-save with no link
// left for the host to paint back over.
test("BOOT short closes the screen from either state", () => {
  assert.deepEqual(step(open({ page: 2, cursor: 1 }), press("BOOT", "short")), { view: null, action: null });
  assert.deepEqual(step(open({ confirming: true }), press("BOOT", "short")), { view: null, action: null });
});

test("no other BOOT gesture is touched, so power-save keeps working", () => {
  for (const kind of ["double", "long"]) {
    assert.deepEqual(step(open(), press("BOOT", kind)).view, open(), `BOOT ${kind} must pass through`);
  }
  assert.equal(isDexCloseGesture(press("BOOT", "short")), true);
  assert.equal(isDexCloseGesture(press("BOOT", "double")), false);
  assert.equal(isDexCloseGesture(press("KEY", "short")), false);
});

// The cursor indexes the owned species ON THIS PAGE, not the 60 cells: all but
// a handful of cells are silhouettes that cannot be picked, and stepping
// through them would be 151 presses to cross the dex.
test("a short press moves the cursor along the page and wraps", () => {
  let view = open();
  view = step(view, press("KEY", "short")).view;
  assert.equal(view.cursor, 1);
  view = step(view, press("KEY", "short")).view;
  assert.equal(view.cursor, 2);
  view = step(view, press("KEY", "short")).view;
  assert.equal(view.cursor, 0, "the last entry on the page wraps to the first");
});

test("a page with one or no owned species never moves the cursor off it", () => {
  assert.equal(step(open(), press("KEY", "short"), 1).view.cursor, 0);
  assert.equal(step(open(), press("KEY", "short"), 0).view.cursor, 0, "an empty page must not divide by zero");
});

test("a long press turns the page and wraps at the end", () => {
  let view = open();
  view = step(view, press("KEY", "long")).view;
  assert.equal(view.page, 1);
  view = step(view, press("KEY", "long")).view;
  assert.equal(view.page, 2);
  view = step(view, press("KEY", "long")).view;
  assert.equal(view.page, 0, "the last page wraps back to the first");
});

// Index 3 of one page has nothing to do with index 3 of the next, and a carried
// index would land on an arbitrary species or off the end of the page.
test("turning the page starts the cursor over", () => {
  const view = step(open({ cursor: 2 }), press("KEY", "long")).view;
  assert.equal(view.page, 1);
  assert.equal(view.cursor, 0);
});

test("a double press opens the confirm screen without swapping anything yet", () => {
  const { view, action } = step(open({ cursor: 2 }), press("KEY", "double"));
  assert.equal(view.confirming, true);
  assert.equal(view.cursor, 2, "confirming must be about the entry under the cursor");
  assert.equal(action, null, "opening the confirm screen is not itself a swap");
});

test("a page holding nothing you own has nothing to confirm", () => {
  const { view, action } = step(open(), press("KEY", "double"), 0);
  assert.equal(view.confirming, false);
  assert.equal(action, null);
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

test("a long press on the confirm screen does not turn the page under it", () => {
  const { view, action } = step(open({ page: 1, confirming: true }), press("KEY", "long"));
  assert.equal(action, null);
  assert.equal(view.page, 1, "paging belongs to the grid, not to the confirm screen");
  assert.equal(view.confirming, true);
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
  for (const kind of ["short", "long", "double"]) {
    assert.equal(step(stale, press("KEY", kind)).view.idleTicks, 0, `KEY ${kind}`);
  }
});

test("the open gesture is recognised on its own, for the dispatcher's benefit", () => {
  assert.equal(isDexOpenGesture(press("KEY", "double")), true);
  assert.equal(isDexOpenGesture(press("KEY", "short")), false);
  assert.equal(isDexOpenGesture(press("BOOT", "double")), false);
  assert.equal(isDexOpenGesture(undefined), false);
});
