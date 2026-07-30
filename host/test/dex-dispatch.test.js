import { test } from "node:test";
import assert from "node:assert/strict";

import { createButtonDispatcher, createActionQueue } from "../src/index.js";

// The screen lives on the dispatcher's immediate path rather than in the tick,
// so these pin the part the pure dex-view tests cannot see: that a press
// actually reaches the panel, and that the animator is parked for exactly as
// long as the screen is up.
function harness({ pet = { species: "bulbasaur", dexCaught: ["bulbasaur", "pidgey"], capturedCount: 1, box: [{ species: "pidgey", level: 7 }] } } = {}) {
  let onButton = null;
  const pushed = [];
  const animator = { depth: 0, pause() { this.depth += 1; }, resume() { this.depth -= 1; } };
  const rendered = [];
  const swaps = [];

  const dispatcher = createButtonDispatcher({
    transport: {
      onButton: (fn) => { onButton = fn; return () => { onButton = null; }; },
      push: async (frame) => { pushed.push(frame); },
    },
    getPet: () => pet,
    getModel: () => ({ buddy: {} }),
    actions: createActionQueue(),
    animator,
    playSignature: async () => { pushed.push("signature"); },
    dexSource: () => ({ dex: pet, progress: { dexCaught: 0, dexTotal: 151 } }),
    renderDex: async ({ page, cursorSpecies }) => { rendered.push(`page-${page}:${cursorSpecies}`); return `page-${page}`; },
    renderConfirm: async ({ entry }) => { rendered.push(`confirm-${entry.species}`); return `confirm-${entry.species}`; },
    swapRequests: swaps,
    logger: null,
  });

  // The dispatcher's work happens on the action queue, so tests have to let it
  // drain before asserting.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { press: (key, kind) => { onButton({ key, kind }); return settle(); }, pushed, rendered, swaps, animator, dispatcher };
}

test("KEY double draws the first page and parks the animator", async () => {
  const h = harness();
  await h.press("KEY", "double");

  assert.deepEqual(h.rendered, ["page-0:bulbasaur"], "the cursor starts on the first roster entry");
  assert.deepEqual(h.pushed, ["page-0"]);
  assert.equal(h.animator.depth, 1, "the animator must be paused while the screen is up");
  assert.equal(h.dispatcher.isDexOpen(), true);
});

test("moving the cursor does not stack more pauses, and closing releases exactly one", async () => {
  const h = harness();
  await h.press("KEY", "double");
  await h.press("KEY", "short");
  await h.press("KEY", "short");

  assert.equal(h.animator.depth, 1, "each cursor move must not add another pause");

  await h.press("BOOT", "short");
  assert.equal(h.dispatcher.isDexOpen(), false);
  assert.equal(h.animator.depth, 0, "closing must leave the animator running again");
});

test("double on the grid shows the confirm screen, and double again requests the swap", async () => {
  const h = harness();
  await h.press("KEY", "double");     // open, cursor on the first roster entry
  await h.press("KEY", "short");      // move to the second
  await h.press("KEY", "double");     // confirm screen
  assert.ok(h.rendered.some((r) => r.startsWith("confirm-")), "the confirm screen must be drawn");
  assert.deepEqual(h.swaps, [], "showing the confirm screen must not swap anything");

  await h.press("KEY", "double");     // confirm
  assert.equal(h.swaps.length, 1);
});

test("cancelling the confirm screen swaps nothing and goes back to the grid", async () => {
  const h = harness();
  await h.press("KEY", "double");
  await h.press("KEY", "short");
  await h.press("KEY", "double");
  await h.press("KEY", "short");      // cancel

  assert.deepEqual(h.swaps, []);
  assert.equal(h.dispatcher.isDexOpen(), true);
  assert.equal(h.animator.depth, 1);
});

// Confirming the one already on the panel is a no-op, not a swap to itself.
test("confirming the active buddy requests nothing", async () => {
  const h = harness();
  await h.press("KEY", "double");     // cursor starts on bulbasaur, which is active
  await h.press("KEY", "double");     // confirm screen
  await h.press("KEY", "double");     // confirm

  assert.deepEqual(h.swaps, []);
});

// A greet animation painted over the pokedex would make the screen flicker
// away under a press that was meant to turn the page.
test("a short KEY press turns the page instead of playing the signature", async () => {
  const h = harness({ pet: { readyToEvolve: false, dexCaught: [], capturedCount: 0, box: [] } });
  await h.press("KEY", "short");
  assert.deepEqual(h.pushed, ["signature"], "with the screen closed, short press still greets");

  await h.press("KEY", "double");
  const after = h.pushed.length;
  await h.press("KEY", "short");
  assert.equal(h.pushed.length, after + 1, "with it open, short press redraws the grid rather than greeting");
  assert.equal(h.pushed.filter((f) => f === "signature").length, 1, "no second greet");
});

// BOOT short is the return gesture; the OTHER BOOT gestures must still pass
// straight through, because the firmware acts on BOOT double by itself.
test("BOOT double and long are left alone, so power-save keeps working", async () => {
  const h = harness();
  await h.press("KEY", "double");
  const before = h.pushed.length;

  await h.press("BOOT", "double");
  await h.press("BOOT", "long");

  assert.equal(h.pushed.length, before, "they must not redraw the screen");
  assert.equal(h.dispatcher.isDexOpen(), true, "nor close it");

  await h.press("BOOT", "short");
  assert.equal(h.dispatcher.isDexOpen(), false, "BOOT short is the one that returns");
});

test("the idle close releases the animator too, not just the flag", async () => {
  const h = harness();
  await h.press("KEY", "double");

  let closed = false;
  for (let i = 0; i < 10 && !closed; i += 1) closed = h.dispatcher.ageDex();

  assert.equal(closed, true, "it must close itself eventually");
  assert.equal(h.dispatcher.isDexOpen(), false);
  assert.equal(h.animator.depth, 0);
  assert.equal(h.dispatcher.ageDex(), false, "ageing a closed screen must not resume again");
});

// Otherwise a render failure parks the animator forever and the panel freezes
// on whatever was last pushed.
test("a screen that fails to render closes itself and unparks the animator", async () => {
  let onButton = null;
  const animator = { depth: 0, pause() { this.depth += 1; }, resume() { this.depth -= 1; } };
  const dispatcher = createButtonDispatcher({
    transport: { onButton: (fn) => { onButton = fn; return () => {}; }, push: async () => {} },
    getPet: () => ({}),
    getModel: () => ({ buddy: {} }),
    actions: createActionQueue(),
    animator,
    dexSource: () => ({ dex: {}, progress: { dexCaught: 0, dexTotal: 151 } }),
    renderDex: async () => { throw new Error("no sprites"); },
    logger: null,
  });

  onButton({ key: "KEY", kind: "double" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(dispatcher.isDexOpen(), false);
  assert.equal(animator.depth, 0);
});

test("with no dexSource the screen does not exist and KEY behaves as before", async () => {
  let onButton = null;
  const pushed = [];
  const dispatcher = createButtonDispatcher({
    transport: { onButton: (fn) => { onButton = fn; return () => {}; }, push: async () => {} },
    getPet: () => ({ readyToEvolve: false }),
    getModel: () => ({ buddy: {} }),
    actions: createActionQueue(),
    animator: { pause() {}, resume() {} },
    playSignature: async () => { pushed.push("signature"); },
    logger: null,
  });

  onButton({ key: "KEY", kind: "double" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dispatcher.isDexOpen(), false);

  onButton({ key: "KEY", kind: "short" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(pushed, ["signature"]);
});
