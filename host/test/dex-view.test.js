import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEX_IDLE_TICKS_BEFORE_CLOSE,
  ageDexView,
  isDexOpenGesture,
  stepDexView,
} from "../src/pet/dex-view.js";

const press = (key, kind) => ({ key, kind });

test("KEY double opens it, and nothing else does", () => {
  assert.equal(stepDexView(null, press("KEY", "double"))?.page, 0);

  for (const event of [
    press("KEY", "short"), press("KEY", "long"), press("KEY", "down"), press("KEY", "up"),
    press("BOOT", "double"), press("BOOT", "short"), press("BOOT", "long"),
    null, undefined, {},
  ]) {
    assert.equal(stepDexView(null, event), null, `${JSON.stringify(event)} must not open it`);
  }
});

// BOOT is power-save's alone. Borrowing it is what stopped the radio on 07-27,
// and the symptom read as dead hardware rather than as a button conflict.
test("BOOT never does anything to the screen, open or closed", () => {
  const open = { page: 1, idleTicks: 0 };
  for (const kind of ["short", "long", "double"]) {
    assert.deepEqual(stepDexView(open, press("BOOT", kind)), open);
    assert.equal(stepDexView(null, press("BOOT", kind)), null);
  }
});

test("KEY turns the page and wraps around at the end", () => {
  let view = { page: 0, idleTicks: 0 };
  view = stepDexView(view, press("KEY", "short"), { pages: 3 });
  assert.equal(view.page, 1);
  view = stepDexView(view, press("KEY", "short"), { pages: 3 });
  assert.equal(view.page, 2);
  view = stepDexView(view, press("KEY", "short"), { pages: 3 });
  assert.equal(view.page, 0, "the last page wraps back to the first");
});

test("a second double press turns the page rather than reopening at page 0", () => {
  const view = stepDexView({ page: 1, idleTicks: 0 }, press("KEY", "double"), { pages: 3 });
  assert.equal(view.page, 2);
});

test("a long KEY press closes it", () => {
  assert.equal(stepDexView({ page: 2, idleTicks: 0 }, press("KEY", "long"), { pages: 3 }), null);
});

test("it closes itself after a stretch of no input", () => {
  let view = { page: 1, idleTicks: 0 };
  for (let i = 1; i < DEX_IDLE_TICKS_BEFORE_CLOSE; i += 1) {
    view = ageDexView(view);
    assert.notEqual(view, null, `still open after ${i} idle tick(s)`);
  }
  assert.equal(ageDexView(view), null, "the last idle tick closes it");
  assert.equal(ageDexView(null), null, "ageing a closed screen is a no-op");
});

// Otherwise reading the pokedex for four minutes closes it under you.
test("any press resets the idle countdown", () => {
  const stale = { page: 0, idleTicks: DEX_IDLE_TICKS_BEFORE_CLOSE - 1 };
  assert.equal(stepDexView(stale, press("KEY", "short"), { pages: 3 }).idleTicks, 0);
});

test("the open gesture is recognised on its own, for the dispatcher's benefit", () => {
  assert.equal(isDexOpenGesture(press("KEY", "double")), true);
  assert.equal(isDexOpenGesture(press("KEY", "short")), false);
  assert.equal(isDexOpenGesture(press("BOOT", "double")), false);
  assert.equal(isDexOpenGesture(undefined), false);
});

test("a single page never wraps into a second one", () => {
  const view = stepDexView({ page: 0, idleTicks: 0 }, press("KEY", "short"), { pages: 1 });
  assert.equal(view.page, 0);
});
