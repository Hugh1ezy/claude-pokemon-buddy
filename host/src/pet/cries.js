import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Idle bubble cries + happy/strained variants, single-sourced from species-cries.json.
const data = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../seed/species-cries.json", import.meta.url)), "utf8"),
);

// `bubble` is optional per species. It used to be read eagerly as `s.bubble.idle`,
// which meant one entry without flavour text threw at import time and took the
// whole host down -- the panel, the tick, the transport, everything, because a
// pokemon had no catchphrase. Found on 2026-07-30 when the cry list grew to 156.
// A species with no bubble falls through to the same "♪" that cryFor already
// returned for a species missing from this file entirely.
const FALLBACK_BUBBLE = { idle: "♪", happy: "♪", strained: "…" };
const VARIANTS = Object.fromEntries(data.species.map((s) => [s.key, s.bubble ?? FALLBACK_BUBBLE]));

// Back-compat: CRIES stays a species->idle-string map; EEVEE_IDLE_CRY is layout's fallback.
export const CRIES = Object.fromEntries(data.species.map((s) => [s.key, (s.bubble ?? FALLBACK_BUBBLE).idle]));
export const EEVEE_IDLE_CRY = CRIES.eevee;

// mood ∈ {happy, focused, strained, fainted, shocked} (deriveMood) or undefined.
export function cryFor(species, mood) {
  const v = VARIANTS[species];
  if (!v) return "♪";
  if (mood === "happy") return v.happy;
  if (mood === "strained" || mood === "fainted" || mood === "shocked") return v.strained;
  return v.idle; // focused / undefined / 其余
}
