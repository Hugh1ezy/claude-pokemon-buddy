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
  const sounds = [];
  const screen = [];

  const dispatcher = createButtonDispatcher({
    transport: {
      onButton: (fn) => { onButton = fn; return () => { onButton = null; }; },
      push: async (frame) => { pushed.push(frame); },
      playSound: (id) => { sounds.push(id); },
      setHostScreen: (on) => { screen.push(on); },
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
  return { press: (key, kind) => { onButton({ key, kind }); return settle(); }, pushed, rendered, swaps, sounds, screen, animator, dispatcher };
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

// The 2026-08-01 bug: the pokedex draws only on input and `shouldPush` stops the
// tick painting over it, so an open, untouched screen sent the device NOTHING.
// The firmware auto-enters local-clock mode after 120s of no frames (two ticks)
// while the screen's own idle-close is three ticks — so the offline clock face
// was certain to appear over the pokedex the owner was looking at.
test("an idle pokedex keeps feeding the device a frame every tick", async () => {
  const h = harness();
  await h.press("KEY", "double");
  const afterOpen = h.pushed.length;

  // Two ticks with no input at all -- the window in which the device used to
  // give up on the host.
  for (let i = 0; i < 2; i += 1) {
    h.dispatcher.ageDex();
    assert.equal(await h.dispatcher.repaintHeldScreen(), true, "the held screen must repaint itself");
  }

  assert.equal(h.pushed.length, afterOpen + 2, "one frame per silent tick, or the device times out");
  assert.equal(h.dispatcher.isDexOpen(), true, "and it is still the pokedex on screen, not the buddy panel");
  assert.deepEqual(h.pushed.slice(afterOpen), ["page-0", "page-0"],
    "the repaint is the pokedex's own frame -- pushing the buddy panel would wipe the screen");
});

test("repaintHeldScreen does nothing when no screen is held", async () => {
  const h = harness();
  // Nothing open: the tick pushes the buddy panel itself, and a keepalive here
  // would be a second writer racing it.
  assert.equal(await h.dispatcher.repaintHeldScreen(), false);
  assert.deepEqual(h.pushed, []);

  // Closed again after having been open -- the same must hold.
  await h.press("KEY", "double");
  await h.press("BOOT", "short");
  const afterClose = h.pushed.length;
  assert.equal(await h.dispatcher.repaintHeldScreen(), false);
  assert.equal(h.pushed.length, afterClose);
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

// ── Where the cry goes (owner, 2026-08-03) ───────────────────────────────────
// It used to fire on every cursor move. Browsing is one press per species, so
// that was a cry per press: they queue, each blocks the speaker for its whole
// length, and the sound you hear stops corresponding to the row you are looking
// at. The zoom is the deliberate "show me this one" and it gets the sound.

test("browsing the pokedex is silent -- opening it, moving the cursor, turning the page", async () => {
  const h = harness();
  await h.press("KEY", "double");   // open
  await h.press("KEY", "short");    // move
  await h.press("KEY", "short");    // move
  await h.press("KEY", "long");     // page

  assert.deepEqual(h.sounds, [], "not one PLAY may be sent while merely browsing");
});

test("zooming in on an owned species plays its cry, once per zoom", async () => {
  const h = harness();
  await h.press("KEY", "double");   // open, cursor on the first entry
  assert.deepEqual(h.sounds, []);

  await h.press("KEY", "double");   // zoom
  assert.equal(h.sounds.length, 1, "the zoom is the press that has a sound");

  // Cancelling and re-zooming the same species plays it again -- it is a fresh
  // "show me this one" -- but nothing in between makes a sound.
  await h.press("KEY", "short");    // cancel back to the grid
  assert.equal(h.sounds.length, 1, "cancelling is silent");
  await h.press("KEY", "double");   // zoom again
  assert.equal(h.sounds.length, 2);
});

test("confirming the swap out of the zoom does not add a second cry", async () => {
  const h = harness();
  await h.press("KEY", "double");   // open
  await h.press("KEY", "short");    // move off the active buddy so there is a swap to make
  await h.press("KEY", "double");   // zoom
  const afterZoom = h.sounds.length;

  await h.press("KEY", "double");   // confirm
  assert.equal(h.sounds.length, afterZoom, "the confirm is the swap, not another look");
  assert.equal(h.swaps.length, 1, "and it really did request the swap");
});

// ── The OTHER half of the silence (owner, 2026-08-03 evening, on hardware) ───
// The tests above only prove the HOST sends no cry. The device was still making
// one on its own: on_key_single plays g_active_cry on every KEY short and the
// firmware cannot see whose screen is on the panel. So browsing was silent from
// here and one constant cry in the room. T_SCREEN is how the host says "I have
// the panel"; these pin that it is sent, and far more importantly that it is
// always taken back.

test("opening the pokedex takes the device's KEY cry, closing gives it back", async () => {
  const h = harness();
  await h.press("KEY", "double");
  assert.deepEqual(h.screen, [true], "the device must be told before the first browsing press");

  await h.press("BOOT", "short");
  assert.deepEqual(h.screen, [true, false], "and told again the moment the buddy has the panel back");
});

test("browsing does not re-send the flag, and the zoom does not drop it", async () => {
  const h = harness();
  await h.press("KEY", "double");   // open
  await h.press("KEY", "short");    // move
  await h.press("KEY", "short");    // move
  await h.press("KEY", "double");   // zoom
  await h.press("KEY", "short");    // cancel
  await h.press("KEY", "long");     // page

  assert.deepEqual(h.screen, [true], "it is a state with two edges, not a per-press message");
});

// Every way the screen can end has to give the cry back. A missed off is not a
// cosmetic bug: KEY stays silent for the rest of the session, on the buddy panel,
// where the cry is the only thing the button does.
test("the idle self-close gives the KEY cry back", async () => {
  const h = harness();
  await h.press("KEY", "double");

  let closed = false;
  for (let i = 0; i < 10 && !closed; i += 1) closed = h.dispatcher.ageDex();

  assert.equal(closed, true);
  assert.deepEqual(h.screen, [true, false], "walking away must not cost the button its sound");
});

test("a screen that fails to render gives the KEY cry back", async () => {
  let onButton = null;
  const screen = [];
  const dispatcher = createButtonDispatcher({
    transport: {
      onButton: (fn) => { onButton = fn; return () => {}; },
      push: async () => {},
      setHostScreen: (on) => { screen.push(on); },
    },
    getPet: () => ({}),
    getModel: () => ({ buddy: {} }),
    actions: createActionQueue(),
    animator: { pause() {}, resume() {} },
    dexSource: () => ({ dex: {}, progress: { dexCaught: 0, dexTotal: 151 } }),
    renderDex: async () => { throw new Error("no sprites"); },
    logger: null,
  });

  onButton({ key: "KEY", kind: "double" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(dispatcher.isDexOpen(), false);
  assert.deepEqual(screen, [true, false], "the unwind has to undo the flag as well as the animator");
});

// ── The capture screen holds the same flag (owner, 2026-08-04) ──────────────
// KEY on this screen is the THROW button, and until today the throw was kept
// quiet by g_bgm_active -- a side effect of the capture music being queued. The
// music is gone, so the flag is the only thing left holding that line. Without
// these, removing a background track silently puts a cry on every throw.
function captureHarness() {
  let onButton = null;
  const screen = [];
  const sounds = [];
  const pet = {
    species: "bulbasaur",
    dexCaught: ["bulbasaur"],
    capturedCount: 1,
    box: [],
    encounter: { species: "pidgey", offeredAt: 0 },
  };

  const dispatcher = createButtonDispatcher({
    transport: {
      onButton: (fn) => { onButton = fn; return () => {}; },
      push: async () => {},
      playSound: (id) => { sounds.push(id); },
      setHostScreen: (on) => { screen.push(on); },
    },
    getPet: () => pet,
    getModel: () => ({ buddy: {} }),
    actions: createActionQueue(),
    animator: { pause() {}, resume() {} },
    dexSource: () => ({ dex: pet, progress: { dexCaught: 1, dexTotal: 151 } }),
    renderDex: async () => "page",
    captureResults: [],
    renderCapture: async () => "capture-frame",
    // Frozen at 0 so the offer never expires under the test; a real clock here
    // would make this depend on how fast the machine runs. With the clock frozen
    // no phase ever reaches its duration, so every phase runs until the abort --
    // which is the path being tested.
    captureNow: () => 0,
    // Still a macrotask, so the test's own presses get scheduled between frames.
    // An already-resolved promise here would starve them and hang the run.
    captureSleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    logger: null,
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { press: (key, kind) => { onButton({ key, kind }); return settle(); }, settle, screen, sounds, dispatcher };
}

test("the capture screen takes the device's KEY cry, and backing out gives it back", async () => {
  const h = captureHarness();

  await h.press("KEY", "double");            // wild pokemon on offer -> capture, not pokedex
  assert.equal(h.dispatcher.isCaptureOpen(), true);
  assert.deepEqual(h.screen, [true], "the device must be told before the first throw can land");

  await h.press("BOOT", "short");            // back out
  for (let i = 0; i < 200 && h.dispatcher.isCaptureOpen(); i += 1) await h.settle();

  assert.equal(h.dispatcher.isCaptureOpen(), false);
  assert.deepEqual(h.screen, [true, false], "and told again the moment the buddy has the panel back");
});

test("the capture screen queues no music", async () => {
  const h = captureHarness();

  await h.press("KEY", "double");
  await h.press("KEY", "short");             // a throw
  await h.press("BOOT", "short");
  for (let i = 0; i < 200 && h.dispatcher.isCaptureOpen(); i += 1) await h.settle();

  assert.deepEqual(h.sounds, [], "no loop, no stop -- the screen is silent unless a catch lands");
});

// The mock transport has no setHostScreen at all, and neither does an older one.
test("a transport without setHostScreen still runs the pokedex", async () => {
  let onButton = null;
  const dispatcher = createButtonDispatcher({
    transport: { onButton: (fn) => { onButton = fn; return () => {}; }, push: async () => {} },
    getPet: () => ({ species: "bulbasaur", dexCaught: ["bulbasaur"], capturedCount: 1, box: [] }),
    getModel: () => ({ buddy: {} }),
    actions: createActionQueue(),
    animator: { pause() {}, resume() {} },
    dexSource: () => ({ dex: { dexCaught: ["bulbasaur"] }, progress: { dexCaught: 1, dexTotal: 151 } }),
    renderDex: async () => "page",
    logger: null,
  });

  onButton({ key: "KEY", kind: "double" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dispatcher.isDexOpen(), true, "the optional call must not throw the screen away");
});
