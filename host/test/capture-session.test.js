import { test } from "node:test";
import assert from "node:assert/strict";

import { runCaptureSession, FRAME_MS } from "../src/pet/capture-session.js";
import { sliderCentre } from "../src/pet/capture.js";
import { SOUND } from "../src/transport/proto.js";

const PHASE = {
  AIM: "aim", THROW: "throw", HIT: "hit", WOBBLE: "wobble",
  CAUGHT: "caught", RETRY: "retry", ESCAPED: "escaped",
};
const PHASES = { throw: 100, hit: 100, wobble: 200, caught: 100, retry: 100, escaped: 100 };
const PARAMS = { bHalf: 0.08, cHalf: 0.20, speed: 0.0005 };

// Aims the throws for us: the clock only moves when the session sleeps, so a
// press can be dropped on an exact millisecond. `aimAt` is a list of offsets
// from the start of each aiming phase -- one per throw.
function harness({ aimOffsets = [], params = PARAMS, target = null, abortAfter = null } = {}) {
  let clock = 0;
  let press = false;
  let phaseStart = 0;
  let throwIndex = -1;
  let aiming = false;
  const pushed = [];

  // rng draws A then the slider phase. Pinning the phase to 0 makes the
  // trajectory predictable so a test can aim at it.
  const draws = [target ?? 0.5, 0];
  let drawn = 0;

  const io = {
    species: "clefairy", zh: "皮皮", params,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      // Only ever press while aiming. An earlier version armed the press during
      // the throw animation too, so the session's stale-press discard consumed
      // it and every throw after the first was aimed at the wrong moment.
      if (aiming) {
        const want = aimOffsets[throwIndex];
        if (want != null && clock - phaseStart >= want) press = true;
      }
      if (abortAfter != null && clock >= abortAfter) io.__abort = true;
    },
    push: async (frame) => { pushed.push(frame); },
    render: async ({ phase, elapsed, rules, kind }) => {
      aiming = phase === PHASE.AIM;
      // A fresh aiming phase is a new throw. Counted here rather than from the
      // press, because this is the one event the session cannot fake.
      if (aiming && elapsed === 0) { phaseStart = clock; throwIndex += 1; }
      return { phase, elapsed, hp: rules?.hp, kind };
    },
    pressed: () => press,
    takePress: () => { press = false; },
    aborted: () => Boolean(io.__abort),
    phases: PHASES, PHASE,
    rng: () => draws[Math.min(drawn++, draws.length - 1)],
  };
  return { io, pushed };
}

const phasesOf = (pushed) => [...new Set(pushed.map((f) => f.phase))];

test("an encounter is two attacks and then the capture", async () => {
  // Target parked where the slider starts, and every press on the same beat, so
  // all three land in B.
  const start = sliderCentre({ params: PARAMS, phase: 0, target: 0 }, FRAME_MS);
  const h = harness({ target: start, aimOffsets: [FRAME_MS, FRAME_MS, FRAME_MS] });
  const result = await runCaptureSession(h.io);

  assert.equal(result.outcome, "caught");
  const kinds = h.pushed.filter((f) => f.phase === PHASE.AIM).map((f) => f.kind);
  assert.equal(kinds.filter((k) => k === "attack").length > 0, true, "the first throws must be attacks");
  assert.ok(phasesOf(h.pushed).includes(PHASE.HIT), "an attack that lands must show the hit");
  assert.ok(phasesOf(h.pushed).includes(PHASE.WOBBLE));
  assert.ok(phasesOf(h.pushed).includes(PHASE.CAUGHT));
});

test("the HP bar falls across the two attacks and stops at 1", async () => {
  const start = sliderCentre({ params: PARAMS, phase: 0, target: 0 }, FRAME_MS);
  const h = harness({ target: start, aimOffsets: [FRAME_MS, FRAME_MS, FRAME_MS] });
  await runCaptureSession(h.io);

  const hps = h.pushed.map((f) => f.hp).filter((v) => v != null);
  assert.equal(hps[0], 12, "it starts full");
  assert.equal(Math.min(...hps), 1, "two clean attacks wear it to exactly 1");
});

// The whole point of the redesign: A must not move between the throws, or the
// two attacks teach nothing about the capture.
test("the target does not move between throws", async () => {
  const start = sliderCentre({ params: PARAMS, phase: 0, target: 0 }, FRAME_MS);
  const h = harness({ target: start, aimOffsets: [FRAME_MS, FRAME_MS, FRAME_MS] });
  await runCaptureSession(h.io);

  // Only two rng draws for the whole encounter: A and the slider phase. A third
  // would mean something was re-rolled.
  assert.equal(h.io.rng(), 0, "after A and phase, the draws must be exhausted");
});

test("the aiming loop runs at the measured frame interval", async () => {
  const h = harness({ aimOffsets: [500, 500, 500] });
  await runCaptureSession(h.io);

  const aim = h.pushed.filter((f) => f.phase === PHASE.AIM);
  const firstRun = [];
  for (const frame of aim) {
    if (frame.elapsed === 0 && firstRun.length) break;
    firstRun.push(frame);
  }
  for (let i = 1; i < firstRun.length; i += 1) {
    assert.equal(firstRun[i].elapsed - firstRun[i - 1].elapsed, FRAME_MS);
  }
});

// BOOT short is the universal way back to the buddy panel. Backing out is
// navigation, not an outcome: nothing was thrown, so nothing fled, and the
// offer has to still be there when you come back.
test("BOOT short backs out without throwing and without ending the encounter", async () => {
  const h = harness({ aimOffsets: [], abortAfter: 300 });
  const result = await runCaptureSession(h.io);

  assert.deepEqual(result, { outcome: "aborted" });
  assert.deepEqual(phasesOf(h.pushed), [PHASE.AIM], "backing out must not play a throw or a flee");
});

// There is no deadline any more -- offerMs governs the notification, not the
// aiming. Standing there is allowed.
test("aiming forever is allowed: nothing times the screen out", async () => {
  const start = sliderCentre({ params: PARAMS, phase: 0, target: 0 }, FRAME_MS);
  const h = harness({ target: start, aimOffsets: [600_000, 100, 100] });
  const result = await runCaptureSession(h.io);

  assert.notEqual(result.outcome, "escaped", "ten minutes of aiming must not lose the pokemon");
  const aim = h.pushed.filter((f) => f.phase === PHASE.AIM);
  assert.ok(aim.length > 1000, `it should still be animating after ten minutes, got ${aim.length} frames`);
});

test("a teleporter gets one throw and it is the capture", async () => {
  const params = { ...PARAMS, teleports: true };
  const start = sliderCentre({ params, phase: 0, target: 0 }, FRAME_MS);
  const h = harness({ params, target: start, aimOffsets: [FRAME_MS] });
  const result = await runCaptureSession(h.io);

  assert.equal(result.outcome, "caught");
  assert.ok(!phasesOf(h.pushed).includes(PHASE.HIT), "there are no attacks to land");
  const kinds = h.pushed.filter((f) => f.phase === PHASE.AIM).map((f) => f.kind);
  assert.ok(!kinds.includes("attack"), "its only throw is the capture");
});

// The title read "投球！" through both attacks because play() forwarded the
// phase but not the kind, so every frame that was not an aiming frame lost
// track of what the throw was for.
test("every frame of an attack knows it is an attack, not just the aiming ones", async () => {
  const start = sliderCentre({ params: PARAMS, phase: 0, target: 0 }, FRAME_MS);
  const h = harness({ target: start, aimOffsets: [FRAME_MS, FRAME_MS, FRAME_MS] });
  await runCaptureSession(h.io);

  const attackPhases = h.pushed.filter((f) => f.kind === "attack").map((f) => f.phase);
  assert.ok(attackPhases.includes(PHASE.THROW), "the throw frames of an attack must carry kind");
  assert.ok(attackPhases.includes(PHASE.HIT), "so must the hit frames");
  assert.ok(
    h.pushed.filter((f) => f.phase === PHASE.WOBBLE).every((f) => f.kind === "capture"),
    "and the wobble only ever belongs to the capture",
  );
});

test("a catch plays the fanfare exactly once, and an abort plays nothing", async () => {
  const start = sliderCentre({ params: PARAMS, phase: 0, target: 0 }, FRAME_MS);
  const caught = harness({ target: start, aimOffsets: [FRAME_MS, FRAME_MS, FRAME_MS] });
  const heard = [];
  const result = await runCaptureSession({ ...caught.io, playSound: (id) => heard.push(id) });

  assert.equal(result.outcome, "caught");
  // Once, not once per frame: PHASE.CAUGHT loops at 20fps for its whole
  // duration, so a call placed inside that loop would fire ~2 times here and
  // dozens of times with the real phase lengths.
  assert.deepEqual(heard, [SOUND.EVOLVE]);

  const bailed = harness({ target: start, aimOffsets: [FRAME_MS], abortAfter: 1 });
  const quiet = [];
  const out = await runCaptureSession({ ...bailed.io, playSound: (id) => quiet.push(id) });

  assert.equal(out.outcome, "aborted");
  assert.deepEqual(quiet, [], "backing out of the screen is not a catch");
});
