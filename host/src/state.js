import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { SLOTS_PER_DAY } from "./pet/bond.js";
import { normalizeDex } from "./pet/dex.js";
import { isDexSpecies } from "./pet/species-meta.js";
import { MAX_LEVEL_EXP, PARAMS, expToNextLevel } from "./pet/sim.js";

// Stays at 1 on purpose even though the save gained the pokedex fields.
// loadState accepts a save only on an exact version match and otherwise falls
// back to the whitelist salvage -- so bumping this would make every machine
// still running older code treat a current save as foreign, strip everything
// it does not recognise, and push the stripped copy back through save-sync.
// The change is purely additive and old code tolerates it (normalizePet copies
// the state object and only touches keys it knows), which is precisely the
// case where a version bump does harm and no good. Bump it when a field
// changes MEANING, not when one is added. See pet/dex.js.
export const SCHEMA_VERSION = 1;
const STONES = new Set(["water", "thunder", "fire"]);
const NUMBER_RANGES = {
  level: { min: 1 },
  // Static outer bound only -- the real ceiling depends on the pet's level and is
  // applied by clampExpToLevel() once `level` itself has been normalized.
  exp: { min: 0, maxExclusive: MAX_LEVEL_EXP },
  bond: { min: 0, max: PARAMS.bondSoftCap },
  streak: { min: 0 },
  shield: { min: 0, max: 2 },
  todayCreditedExp: { min: 0 },
  todayCreditedBond: { min: 0 },
  careCount: { min: 0 },
  bondHalves: { min: 0, max: SLOTS_PER_DAY },
  bondSlots: { min: 0, max: (1 << SLOTS_PER_DAY) - 1 },
};

export function saveState(path, state) {
  const tmp = `${path}.tmp`;
  const bak = `${path}.bak`;

  if (isParseableJsonFile(path)) {
    copyFileSync(path, bak);
  }

  writeFileSync(tmp, JSON.stringify({ ...state, schemaVersion: SCHEMA_VERSION }));
  fsyncFile(tmp);
  renameSync(tmp, path);
  fsyncDirectory(dirname(path));
}

export function loadState(path, { logger = console } = {}) {
  const partials = [];
  let sawStateFile = false;

  for (const candidate of [path, `${path}.bak`]) {
    if (!existsSync(candidate)) continue;
    sawStateFile = true;
    try {
      const state = JSON.parse(readFileSync(candidate, "utf8"));
      if (isValidState(state)) return normalizePet(state);
      const salvaged = salvageState(state);
      if (Object.keys(salvaged).length > 0) partials.push(salvaged);
    } catch {
      // Try the backup, then rebuild below.
    }
  }

  const salvaged = mergeSalvage(partials);
  const rebuilt = normalizePet({ schemaVersion: SCHEMA_VERSION, _rebuilt: true, ...salvaged });
  if (sawStateFile) {
    logger?.warn?.("state files invalid; rebuilding from salvageable fields", {
      path,
      salvaged: Object.keys(rebuilt).filter((key) => key !== "schemaVersion" && key !== "_rebuilt"),
    });
  }
  return rebuilt;
}

function isValidState(state) {
  return Boolean(
    state &&
      typeof state === "object" &&
      !Array.isArray(state) &&
      state.schemaVersion === SCHEMA_VERSION,
  );
}

function salvageState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {};

  const out = {};
  copyString(out, state, "species");
  copyNumber(out, state, "level");
  copyNumber(out, state, "exp");
  copyNumber(out, state, "bond");
  copyNumber(out, state, "streak");
  copyNumber(out, state, "shield");
  copyNumber(out, state, "todayCreditedExp");
  copyNumber(out, state, "todayCreditedBond");
  copyNumber(out, state, "careCount");
  copyNumber(out, state, "bondHalves");
  copyNumber(out, state, "bondSlots");
  copyString(out, state, "lastSettled");
  copyString(out, state, "lastGrowthDay");
  copyString(out, state, "bondDay");
  copyBoolean(out, state, "readyToEvolve");
  copyBoolean(out, state, "hatched");
  copyString(out, state, "name");
  copyIv(out, state, "iv");
  copyString(out, state, "nature");
  copyString(out, state, "characteristic");
  copyStone(out, state, "stone");
  if (Array.isArray(state.pendingCandidates)) out.pendingCandidates = state.pendingCandidates;
  copyDex(out, state);
  copyEncounter(out, state);
  return out;
}

// The offer standing when the host stopped. Worth salvaging so that restarting
// mid-encounter does not silently drop the one on screen, but never repaired:
// a half-readable encounter is discarded outright, because the cooldown clock
// lives in the same object and a plausible-looking wrong timestamp would either
// suppress encounters for hours or defeat the cooldown entirely.
function copyEncounter(out, state) {
  const encounter = normalizeEncounter(state?.encounter);
  if (encounter) out.encounter = encounter;
}

function normalizeEncounter(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const species = typeof raw.species === "string" && isDexSpecies(raw.species) ? raw.species : null;
  const offeredAt = epochMs(raw.offeredAt);
  const lastEndedAt = epochMs(raw.lastEndedAt);

  // An offer without the moment it was made cannot be expired, so it would hang
  // on the panel forever. Drop the species and keep the cooldown.
  if (species && offeredAt == null) {
    return lastEndedAt == null ? null : { species: null, lastEndedAt };
  }
  if (species) {
    return lastEndedAt == null
      ? { species, offeredAt }
      : { species, offeredAt, lastEndedAt };
  }
  return lastEndedAt == null ? null : { species: null, lastEndedAt };
}

function epochMs(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// The dex is the one part of the save that cannot be re-earned: a lost level
// comes back in a day, a lost pokedex is months of encounters. So it is
// salvaged too rather than left to the whitelist's default of "unknown key,
// drop it" -- normalizeDex is built to take garbage and return the largest
// self-consistent dex it can, which is exactly what a salvage wants.
function copyDex(out, state) {
  if (!hasDexFields(state)) return;
  Object.assign(out, normalizeDex(state));
}

function hasDexFields(state) {
  return "dexCaught" in state || "capturedCount" in state || "box" in state;
}

function mergeSalvage(partials) {
  return partials.reduce((merged, partial) => ({ ...partial, ...merged }), {});
}

function normalizePet(state) {
  const out = { ...state };
  normalizeDate(out, "lastSettled");
  normalizeDate(out, "lastGrowthDay");
  normalizeDate(out, "bondDay");
  normalizeNumber(out, "level");
  normalizeNumber(out, "exp");
  normalizeNumber(out, "bond");
  normalizeNumber(out, "streak");
  normalizeNumber(out, "shield");
  normalizeNumber(out, "todayCreditedExp");
  normalizeNumber(out, "todayCreditedBond");
  normalizeNumber(out, "careCount");
  normalizeNumber(out, "bondHalves");
  normalizeNumber(out, "bondSlots");
  clampExpToLevel(out);
  // Only when the save already carries a dex. A save from before the pokedex
  // existed stays byte-identical through a load/save round trip, which is what
  // keeps the other machine's copy from churning in save-sync for no reason.
  if (hasDexFields(out)) Object.assign(out, normalizeDex(out));
  // Same "only if present" rule as the dex, and for the same reason: a save
  // that has never seen an encounter must round-trip byte-identical.
  if ("encounter" in out) {
    const encounter = normalizeEncounter(out.encounter);
    if (encounter) out.encounter = encounter;
    else delete out.encounter;
  }
  return out;
}

// A persisted `exp` must sit inside the current level's own bar, which is only
// knowable after `level` is normalized -- a save carried over from a wider level
// (or a hand-edited file) would otherwise render a >100% EXP bar. A maxed buddy
// is the one case allowed to sit exactly at the ceiling: that is what a full bar
// with nothing left to spend on looks like.
function clampExpToLevel(out) {
  if (typeof out.exp !== "number") return;
  const level = out.level ?? 1;
  const ceiling = expToNextLevel(level);
  if (level >= PARAMS.maxLevel) {
    if (out.exp > ceiling) out.exp = ceiling;
    return;
  }
  if (out.exp >= ceiling) out.exp = ceiling - 1;
}

function normalizeDate(out, key) {
  if (!(key in out)) return;
  if (!isSemanticYmd(out[key])) delete out[key];
}

function isSemanticYmd(value) {
  if (typeof value !== "string") return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(Number(date))) return false;
  try {
    return date.toISOString().slice(0, 10) === value;
  } catch {
    return false;
  }
}

function normalizeNumber(out, key) {
  if (!(key in out)) return;
  const value = out[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    delete out[key];
    return;
  }
  out[key] = clampNumber(value, NUMBER_RANGES[key]);
}

function clampNumber(value, range) {
  let next = value;
  if (range.min != null) next = Math.max(range.min, next);
  if (range.max != null) next = Math.min(range.max, next);
  if (range.maxExclusive != null && next >= range.maxExclusive) {
    next = range.maxExclusive - 1;
  }
  return next;
}

function copyString(out, state, key) {
  if (typeof state[key] === "string" && state[key].length > 0) out[key] = state[key];
}

function copyNumber(out, state, key) {
  const value = state[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  if (!isInRange(value, NUMBER_RANGES[key])) return;
  out[key] = value;
}

function isInRange(value, range) {
  if (range.min != null && value < range.min) return false;
  if (range.max != null && value > range.max) return false;
  if (range.maxExclusive != null && value >= range.maxExclusive) return false;
  return true;
}

function copyBoolean(out, state, key) {
  if (typeof state[key] === "boolean") out[key] = state[key];
}

function copyIv(out, state, key) {
  const value = state[key];
  if (
    Array.isArray(value) &&
    value.length === 6 &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item <= 31)
  ) {
    out[key] = value;
  }
}

function copyStone(out, state, key) {
  if (STONES.has(state[key])) out[key] = state[key];
}

function isParseableJsonFile(path) {
  if (!existsSync(path)) return false;
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return true;
  } catch {
    return false;
  }
}

function fsyncFile(path) {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path) {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is not supported on every platform.
  }
}
