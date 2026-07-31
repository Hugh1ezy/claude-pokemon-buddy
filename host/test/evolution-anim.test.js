import { test } from "node:test";
import assert from "node:assert/strict";
import { playEvolutionAnimation, renderEvolutionFrame } from "../src/render/evolution-anim.js";
import { MUSIC } from "../src/pet/music-audio.js";

function spyTransport() {
  const events = [];
  let inFlight = false;
  return {
    events,
    async push(frame) {
      assert.equal(inFlight, false, "push must not overlap (sequential)");
      inFlight = true;
      await Promise.resolve();
      inFlight = false;
      events.push({ t: "push", frame });
      return { ok: true };
    },
    playSound(id) {
      events.push({ t: "sound", id });
    },
  };
}

test("evolution animation pushes frames sequentially, plays its track once", async () => {
  const tr = spyTransport();
  await playEvolutionAnimation({
    transport: tr,
    fromSpecies: "eevee",
    toSpecies: "espeon",
    delay: async () => {},
  });

  const pushes = tr.events.filter((e) => e.t === "push").length;
  const sounds = tr.events.filter((e) => e.t === "sound" && e.id === MUSIC.EVOLUTION).length;
  assert.ok(pushes >= 12, "expect black×2 + alt×8 + black×2 + reveal");
  assert.equal(sounds, 1, "the evolution track played exactly once");
});

test("alternation frames differ for from vs to species", async () => {
  const from = await renderEvolutionFrame("sprite", { species: "eevee", fromSpecies: "eevee", toSpecies: "espeon" });
  const to = await renderEvolutionFrame("sprite", { species: "espeon", fromSpecies: "eevee", toSpecies: "espeon" });

  assert.ok(!from.pngBuffer.equals(to.pngBuffer), "from/to sprite frames must differ");
});
