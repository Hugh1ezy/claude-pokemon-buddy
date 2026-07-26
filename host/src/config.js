import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const DEFAULTS = {
  name: "阿布",
  planTokenBudget5h: 220_000,
  planTokenBudgetWeek: 2_000_000,
  lat: -36.8485,
  lon: 174.7633,
  box: ["eevee"],
  quietHours: { start: 22, end: 8 },
  volume: 70,
};

export function loadConfig(path = "config.json", { logger = console } = {}) {
  const primary = readJson(path);
  if (primary.ok) return { ...DEFAULTS, ...primary.value };
  if (primary.missing) return { ...DEFAULTS };

  const backup = readJson(`${path}.bak`);
  if (backup.ok) {
    logger?.warn?.("config primary invalid; loading backup", { path, backup: `${path}.bak` });
    return { ...DEFAULTS, ...backup.value };
  }

  try {
    writeFileSync(`${path}.corrupt`, primary.raw ?? "");
  } catch {
    // Best-effort evidence only; returning defaults keeps the dashboard usable.
  }
  logger?.warn?.("config files invalid; using defaults", { path, backup: `${path}.bak` });
  return { ...DEFAULTS };
}

export function saveConfig(path = "config.json", config) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const bak = `${path}.bak`;

  if (isParseableJsonFile(path)) {
    copyFileSync(path, bak);
  }

  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fsyncFile(tmp);
  renameSync(tmp, path);
  fsyncDirectory(dirname(path));
}

function readJson(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { ok: false, missing: true };
    return { ok: false, missing: false, raw: "" };
  }

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, missing: false, raw };
  }
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
