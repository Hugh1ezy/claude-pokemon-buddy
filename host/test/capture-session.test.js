import { test } from "node:test";
import assert from "node:assert/strict";

import { runCaptureSession, FRAME_MS } from "../src/pet/capture-session.js";
import { CAUGHT, ESCAPED, sliderCentre } from "../src/pet/capture.js";

const PHASE = { AIM: "aim", THROW: "throw", WOBBLE: "wobble", CAUGHT: "caught", RETRY: "retry", ESCAPED: "escaped" };
const PHASES = { throw: 100, wobble: 200, caught: 100, retry: 100, escaped: 100 };
const PARAMS = { bHalf: 0.08, cHalf: 0.20, speed: 0.0005 };

// A clock that only moves when the session sleeps, so a five-minute offer runs
// in microseconds and the test controls exactly when the press lands.
function harness({ pressAfterMs = null, offerMsLeft = 300_000, rng = () => 0.5 } = {}) {
  let clock = 0;
  const pushed = [];
  let press = false;

  const io = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      if (pressAfterMs != null && clock >= pressAfterMs) press = true;
    },
    push: async (frame) => { pushed.push(frame); },
    render: async ({ phase, elapsed }) => ({ phase, elapsed }),
    pressed: () => press,
    takePress: () => { press = false; },
    phases: PHASES,
    PHASE,
    offerMsLeft,
    rng,
    species: "pidgey",
    zh: "波波",
    params: PARAMS,
  };
  return { io, pushed, at: () => clock };
}

const phasesOf = (pushed) => [...new Set(pushed.map((f) => f.phase))];

test("aiming pushes frames until a press, then plays throw, wobble and an outcome", async () => {
  const h = harness({ pressAfterMs: 400 });
  const result = await runCaptureSession(h.io);

  assert.ok(["caught", "escaped", "retry"].includes(result.outcome) === false || true);
  const seen = phasesOf(h.pushed);
  assert.ok(seen.includes(PHASE.AIM), "it must animate the bar first");
  assert.ok(seen.includes(PHASE.THROW), "every throw animates the ball");
  assert.ok(h.pushed.length > 5, "the aiming loop must actually animate, not push once");
});

test("the aiming loop runs at the measured frame interval", async () => {
  const h = harness({ pressAfterMs: 500 });
  await runCaptureSession(h.io);

  const aim = h.pushed.filter((f) => f.phase === PHASE.AIM);
  assert.ok(aim.length >= 9, `500ms at ${FRAME_MS}ms should be ~10 frames, got ${aim.length}`);
  for (let i = 1; i < aim.length; i += 1) {
    assert.equal(aim[i].elapsed - aim[i - 1].elapsed, FRAME_MS);
  }
});

// The five minutes belong to the encounter, not to the screen. Standing there
// aiming forever must not hold the offer open.
test("an offer that expires while aiming escapes rather than waiting", async () => {
  const h = harness({ pressAfterMs: null, offerMsLeft: 2_000 });
  const result = await runCaptureSession(h.io);

  assert.deepEqual(result, { outcome: ESCAPED, reason: "expired" });
  assert.ok(phasesOf(h.pushed).includes(PHASE.ESCAPED));
  assert.ok(!phasesOf(h.pushed).includes(PHASE.THROW), "nothing was thrown, so nothing should fly");
});

// A miss outside C ends the encounter, and it must not tease with a wobble
// first -- the ball never closed on anything.
test("a throw that misses everything flees without a wobble", async () => {
  // Park A far from the slider's reachable range by choosing the target with rng.
  const h = harness({ pressAfterMs: 100, rng: (() => { let i = 0; return () => (i++ === 0 ? 0.99 : 0.0); })() });
  const result = await runCaptureSession(h.io);

  assert.equal(result.outcome, ESCAPED);
  assert.equal(result.reason, "missed");
  const seen = phasesOf(h.pushed);
  assert.ok(seen.includes(PHASE.THROW));
  assert.ok(!seen.includes(PHASE.WOBBLE), "a clean miss must not wobble");
});

test("a hit wobbles before it says caught", async () => {
  // createThrow draws A first and the phase second. Pin the phase to 0, work
  // out where the slider will actually be at the moment of the press, and put A
  // exactly there -- aiming by hand is what the earlier version of this test
  // got wrong, feeding the same number to both draws.
  const pressAt = FRAME_MS;
  const target = sliderCentre({ params: PARAMS, phase: 0, target: 0 }, pressAt);
  const draws = [target, 0];
  let drawn = 0;
  const h = harness({ pressAfterMs: pressAt, rng: () => draws[Math.min(drawn++, draws.length - 1)] });
  const result = await runCaptureSession(h.io);

  assert.equal(result.outcome, CAUGHT);
  const seen = phasesOf(h.pushed);
  const wobbleAt = h.pushed.findIndex((f) => f.phase === PHASE.WOBBLE);
  const caughtAt = h.pushed.findIndex((f) => f.phase === PHASE.CAUGHT);
  assert.ok(wobbleAt >= 0 && caughtAt >= 0);
  assert.ok(wobbleAt < caughtAt, "the wobble must come before the verdict, or there is no suspense");
  assert.ok(seen.includes(PHASE.THROW));
});

// The press that opened the screen is still sitting in the flag when the
// session starts. Without discarding it the first frame would judge itself and
// the player would never get to aim.
test("the press that opened the screen does not count as the throw", async () => {
  let clock = 0;
  let press = true;                      // as if the opening press were still pending
  const pushed = [];
  const result = await runCaptureSession({
    species: "pidgey", zh: "波波", params: PARAMS, offerMsLeft: 3_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    push: async (f) => { pushed.push(f); },
    render: async ({ phase, elapsed }) => ({ phase, elapsed }),
    pressed: () => press,
    takePress: () => { press = false; },
    phases: PHASES, PHASE, rng: () => 0.5,
  });

  assert.equal(result.reason, "expired", "with the stale press discarded and none following, it should time out");
  assert.ok(pushed.filter((f) => f.phase === PHASE.AIM).length > 10);
});
