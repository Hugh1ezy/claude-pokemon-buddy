import { spawn } from "node:child_process";
import path from "node:path";

export async function loadUsageSnapshot({ run = runCcusage, today = localYmd(new Date()), timeZone = hostTimeZone() } = {}) {
  try {
    // --yes skips npx's first-run "Ok to proceed?" prompt. With stdin ignored
    // that prompt hangs forever and wedges the whole tick loop.
    // timeZone pins ccusage's daily/blocks bucketing to the host's local calendar
    // (ccusage buckets by UTC by default), so daily.period aligns with the local
    // `today` from localYmd — otherwise non-UTC users mis-credit today's tokens and
    // mis-judge activeDays across the day boundary (see AR8/PRE-1).
    const blocksJson = await run("npx", ["--yes", "ccusage", "blocks", "--json"], { timeZone });
    const dailyJson = await run("npx", ["--yes", "ccusage", "daily", "--json"], { timeZone });
    return {
      ok: true,
      ...normalizeUsage({ blocksJson, dailyJson, today }),
    };
  } catch (error) {
    return { ok: false, reason: errorReason(error) };
  }
}

export function usageForDisplay(snapshot, lastKnown = null) {
  if (snapshot?.ok) {
    return { usage: snapshot, lastKnown: snapshot };
  }

  if (lastKnown) {
    return {
      usage: { ...lastKnown, ok: false, degraded: true, stale: true },
      lastKnown,
    };
  }

  return {
    usage: {
      ok: false,
      degraded: true,
      stale: false,
      modelled: false,
      p5h: null,
      pweek: null,
      resets5h: null,
      resetsWeek: null,
      activeTokens: null,
      activeCost: null,
      todayPeriod: null,
      activeDays: null,
      todayTokens: null,
      todayCost: null,
      weekTokens: null,
      perType: {},
    },
    lastKnown: null,
  };
}

export function normalizeUsage({ blocksJson, dailyJson, today = localYmd(new Date()) }) {
  const blocksRoot = JSON.parse(blocksJson);
  const dailyRoot = JSON.parse(dailyJson);
  const blocks = arrayField(blocksRoot.blocks, "ccusage blocks schema drift");
  const daily = arrayField(dailyRoot.daily, "ccusage daily schema drift");
  const active = blocks.find((block) => block?.isActive === true);
  if (!active) throw new Error("ccusage active block missing");
  if (daily.length === 0) throw new Error("ccusage daily history missing");

  const activeTokens = numberField(active.totalTokens, "block.totalTokens");
  const weekTokens = daily
    .slice(-7)
    .reduce((sum, day) => sum + numberField(day.totalTokens, "daily.totalTokens"), 0);
  const latest = daily.at(-1);
  const todayPeriod = stringField(latest.period, "daily.period");
  const latestTokens = numberField(latest.totalTokens, "daily.totalTokens");
  const latestCost = numberField(latest.totalCost, "daily.totalCost");
  const latestIsToday = todayPeriod === today;

  const activeDays = daily
    .filter((day) => numberField(day.totalTokens, "daily.totalTokens") > 0)
    .map((day) => stringField(day.period, "daily.period"));

  // Percentages/resets are owned by the official statusline rate-limits feed
  // (see rate-limits.js); ccusage here only sources cost/token totals.
  return {
    modelled: false,
    p5h: null,
    pweek: null,
    resets5h: null,
    resetsWeek: null,
    activeTokens,
    todayPeriod,
    activeDays,
    todayTokens: latestIsToday ? latestTokens : 0,
    todayCost: latestIsToday ? latestCost : 0,
    weekTokens,
    perType: {},
  };
}

export function runCcusage(command, args, { timeoutMs = 60_000, timeZone, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    // Windows can't exec npx directly — it's npx.cmd, and CreateProcess only runs
    // .cmd/.bat files through a shell (spawn() without shell:true throws ENOENT).
    // args here are fixed literals (no user input), so shell interpolation is safe.
    const child = spawnImpl(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: ccusageEnv(timeZone),
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";

    // Hard ceiling so a hung child (network stall, npx download wedge) can never
    // block the tick loop forever — fail-closed to degraded usage instead.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ccusage timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`ccusage exited ${code}: ${stderr.trim()}`));
      }
    });
  });
}

function arrayField(value, message) {
  if (!Array.isArray(value)) throw new Error(message);
  return value;
}

function numberField(value, label) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`expected number: ${label}`);
}

function stringField(value, label) {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`expected string: ${label}`);
}

function errorReason(error) {
  return error?.message ? error.message : "error";
}

// Host's IANA timezone (e.g. "Pacific/Auckland"); null if unavailable so callers
// fall back to ccusage's default bucketing rather than forcing a bad zone.
export function hostTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz.length > 0 ? tz : null;
  } catch {
    return null;
  }
}

// Child env for the ccusage npx spawn. Two jobs:
//  1. Guarantee npx is on PATH. Under macOS launchd the host inherits a bare PATH
//     without /opt/homebrew/bin, so spawn("npx", ...) fails ENOENT forever and the
//     device shows "today $-- · -- tok" with no EXP. npx always lives next to the
//     node binary (dirname(process.execPath)), so we prepend that dir to PATH —
//     making the child self-sufficient regardless of the inherited PATH.
//  2. Set CCUSAGE_TIMEZONE to the host zone (only when provided). Using the env var
//     (not the --timezone flag) is backward-safe: an old ccusage silently ignores an
//     unknown env (degrades to status-quo UTC bucketing) whereas an unknown flag
//     would exit non-zero and wedge usage. When timeZone is null we leave it unset.
export function ccusageEnv(timeZone, baseEnv = process.env, execPath = process.execPath) {
  const env = { ...baseEnv };
  if (timeZone) env.CCUSAGE_TIMEZONE = timeZone;

  // Windows env keys are case-insensitive ("Path" vs "PATH"); reuse the existing key
  // so we extend rather than shadow it.
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const nodeDir = path.dirname(execPath);
  const entries = (env[pathKey] ?? "").split(path.delimiter).filter(Boolean);
  if (!entries.includes(nodeDir)) {
    env[pathKey] = [nodeDir, ...entries].join(path.delimiter);
  }
  return env;
}

function localYmd(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
