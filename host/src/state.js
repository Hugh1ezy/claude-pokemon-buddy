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
import { MAX_LEVEL_EXP, PARAMS, expToNextLevel } from "./pet/sim.js";

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
  copyString(out, state, "lastSettled");
  copyString(out, state, "lastGrowthDay");
  copyBoolean(out, state, "readyToEvolve");
  copyBoolean(out, state, "hatched");
  copyString(out, state, "name");
  copyIv(out, state, "iv");
  copyString(out, state, "nature");
  copyString(out, state, "characteristic");
  copyStone(out, state, "stone");
  if (Array.isArray(state.pendingCandidates)) out.pendingCandidates = state.pendingCandidates;
  return out;
}

function mergeSalvage(partials) {
  return partials.reduce((merged, partial) => ({ ...partial, ...merged }), {});
}

function normalizePet(state) {
  const out = { ...state };
  normalizeDate(out, "lastSettled");
  normalizeDate(out, "lastGrowthDay");
  normalizeNumber(out, "level");
  normalizeNumber(out, "exp");
  normalizeNumber(out, "bond");
  normalizeNumber(out, "streak");
  normalizeNumber(out, "shield");
  normalizeNumber(out, "todayCreditedExp");
  normalizeNumber(out, "todayCreditedBond");
  normalizeNumber(out, "careCount");
  clampExpToLevel(out);
  return out;
}

// A persisted `exp` must sit strictly inside the current level's own bar, which is
// only knowable after `level` is normalized -- a save carried over from a wider
// level (or a hand-edited file) would otherwise render a >100% EXP bar.
function clampExpToLevel(out) {
  if (typeof out.exp !== "number") return;
  const ceiling = expToNextLevel(out.level ?? 1);
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
