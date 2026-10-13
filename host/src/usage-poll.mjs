import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
export const USAGE_PATH = join(homedir(), ".claude", "cpb-usage.json");

const DEFAULT_VERSION = "2.1.0";
const OAUTH_BETA = "oauth-2025-04-20";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const FETCH_TIMEOUT_MS = 10_000;
// Renewing the CLI's own sign-in, the way the CLI does it. On a machine where
// Claude is only ever used through the desktop app nothing else opens the CLI,
// so nothing else would renew the access token and the usage rows would go
// back to "--" about eight hours after every login (measured 2026-10-13: the
// token issued at 14:03 expires at 22:03). Endpoint, client id and body shape
// are the ones the bundled claude.exe uses.
export const TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const defaultAttemptState = { lastAttemptSec: 0 };

export function readOAuthToken({
  platform = process.platform,
  home = homedir(),
  exec = runCommand,
  readFile = readFileSync,
} = {}) {
  try {
    const raw = platform === "darwin"
      ? exec("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { timeoutMs: 2_000 })
      : readFile(join(home, ".claude", ".credentials.json"), "utf8");
    return tokenFromCredentials(outputText(raw));
  } catch {
    return null;
  }
}

// Renews the credentials file in place when the access token is about to
// expire. Never throws and never logs a token. A refresh token is single-use:
// the reply carries its replacement, so the file is rewritten atomically and
// every field this code does not understand is kept as it was.
export async function refreshCredentialsIfNeeded({
  platform = process.platform,
  home = homedir(),
  now = Date.now(),
  readFile = readFileSync,
  fetchImpl = globalThis.fetch,
  timeoutSignal = defaultTimeoutSignal,
  mkdir = mkdirSync,
  writeFile = writeFileSync,
  rename = renameSync,
  force = false,
} = {}) {
  try {
    if (platform === "darwin") return { refreshed: false, reason: "keychain" };
    const path = join(home, ".claude", ".credentials.json");
    const parsed = JSON.parse(outputText(readFile(path, "utf8")));
    const oauth = parsed?.claudeAiOauth;
    const expiresAt = Number(oauth?.expiresAt);
    if (typeof oauth?.refreshToken !== "string" || !Number.isFinite(expiresAt)) {
      return { refreshed: false, reason: "not-refreshable" };
    }
    if (!force && expiresAt - now > REFRESH_MARGIN_MS) return { refreshed: false, reason: "fresh" };
    if (typeof fetchImpl !== "function") return { refreshed: false, reason: "no-fetch" };

    const body = { grant_type: "refresh_token", refresh_token: oauth.refreshToken, client_id: OAUTH_CLIENT_ID };
    if (Array.isArray(oauth.scopes) && oauth.scopes.length > 0) body.scope = oauth.scopes.join(" ");
    const res = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      signal: timeoutSignal(FETCH_TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res?.status !== 200) return { refreshed: false, reason: `http-${Number(res?.status) || "error"}` };
    const data = await res.json();
    if (typeof data?.access_token !== "string" || data.access_token.length === 0) {
      return { refreshed: false, reason: "bad-reply" };
    }

    const next = {
      ...parsed,
      claudeAiOauth: {
        ...oauth,
        accessToken: data.access_token,
        refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : oauth.refreshToken,
        expiresAt: now + (Number(data.expires_in) || 0) * 1000,
        ...(typeof data.scope === "string" ? { scopes: data.scope.split(" ").filter(Boolean) } : {}),
      },
    };
    writeUsageFile(path, next, { mkdir, writeFile, rename });
    return { refreshed: true };
  } catch {
    return { refreshed: false, reason: "error" };
  }
}

// The synchronous half of the question, so a poll whose token is fine does not
// take an extra turn of the event loop to find that out.
export function credentialsExpiring({ platform = process.platform, home = homedir(), now = Date.now(), readFile = readFileSync } = {}) {
  try {
    if (platform === "darwin") return false;
    const oauth = JSON.parse(outputText(readFile(join(home, ".claude", ".credentials.json"), "utf8")))?.claudeAiOauth;
    const expiresAt = Number(oauth?.expiresAt);
    return typeof oauth?.refreshToken === "string" && Number.isFinite(expiresAt) && expiresAt - now <= REFRESH_MARGIN_MS;
  } catch {
    return false;
  }
}

export function ccVersion({ exec = runCommand } = {}) {
  try {
    const out = outputText(exec("claude", ["--version"], { timeoutMs: 2_000 }));
    return out.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? DEFAULT_VERSION;
  } catch {
    return DEFAULT_VERSION;
  }
}

export async function fetchUsage(
  token,
  { version = DEFAULT_VERSION, fetchImpl = globalThis.fetch, timeoutSignal = defaultTimeoutSignal } = {},
) {
  try {
    if (!token || typeof fetchImpl !== "function") return null;
    const res = await fetchImpl(USAGE_ENDPOINT, {
      method: "GET",
      signal: timeoutSignal(FETCH_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
        "User-Agent": `claude-code/${version || DEFAULT_VERSION}`,
        "Content-Type": "application/json",
      },
    });
    if (typeof res?.status !== "number") return null;
    if (res.status !== 200) return { status: res.status, data: null };
    return { status: res.status, data: await res.json() };
  } catch {
    return null;
  }
}

export function toUsageFileShape(apiResp, nowMs) {
  return {
    fiveHourPct: numOrNull(apiResp?.five_hour?.utilization),
    fiveHourReset: isoToEpoch(apiResp?.five_hour?.resets_at),
    weeklyPct: numOrNull(apiResp?.seven_day?.utilization),
    weeklyReset: isoToEpoch(apiResp?.seven_day?.resets_at),
    writtenAt: Math.floor(nowMs / 1000),
  };
}

export async function pollUsageOnce({
  usagePath = USAGE_PATH,
  now = Date.now(),
  minIntervalSec = 180,
  platform = process.platform,
  home = homedir(),
  exec = runCommand,
  readFile = readFileSync,
  fetchImpl = globalThis.fetch,
  version,
  readOAuthTokenImpl = readOAuthToken,
  ccVersionImpl = ccVersion,
  fetchUsageImpl = fetchUsage,
  // Only alongside the real token reader: a caller that supplies its own token
  // has said where the token comes from, and must not have this reach for the
  // credentials file in the real home directory behind its back.
  refreshImpl = readOAuthTokenImpl === readOAuthToken ? refreshCredentialsIfNeeded : null,
  timeoutSignal = defaultTimeoutSignal,
  mkdir = mkdirSync,
  writeFile = writeFileSync,
  rename = renameSync,
  attemptState = defaultAttemptState,
} = {}) {
  try {
    const nowMs = typeof now === "function" ? now() : now;
    if (isThrottled({ usagePath, nowMs, minIntervalSec, readFile })) {
      return { ok: true, skipped: true };
    }

    const nowSec = Math.floor(nowMs / 1000);
    if (isAttemptThrottled({ attemptState, nowSec, minIntervalSec })) {
      return { ok: true, skipped: true };
    }
    markAttempt(attemptState, nowSec);

    if (refreshImpl && credentialsExpiring({ platform, home, now: nowMs, readFile })) {
      await refreshImpl({ platform, home, now: nowMs, readFile, fetchImpl, timeoutSignal, mkdir, writeFile, rename });
    }
    const token = await readOAuthTokenImpl({ platform, home, exec, readFile });
    if (!token) return { ok: false, reason: "no-token" };

    const resolvedVersion = version ?? ccVersionImpl({ exec });
    const fetchResult = await fetchUsageImpl(token, { version: resolvedVersion, fetchImpl, timeoutSignal });
    if (!fetchResult) return { ok: false, reason: "fetch-failed" };
    if (fetchResult.status !== 200) {
      const status = Number(fetchResult.status);
      return { ok: false, reason: Number.isFinite(status) ? `http-${status}` : "fetch-failed" };
    }

    const out = toUsageFileShape(fetchResult.data, nowMs);
    writeUsageFile(usagePath, out, { mkdir, writeFile, rename });
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

function runCommand(command, args, { timeoutMs = 2_000 } = {}) {
  const res = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${command} exited ${res.status}`);
  return res.stdout ?? "";
}

function tokenFromCredentials(raw) {
  const parsed = JSON.parse(raw);
  const token = parsed?.claudeAiOauth?.accessToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

function outputText(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value?.stdout === "string") return value.stdout;
  if (Buffer.isBuffer(value?.stdout)) return value.stdout.toString("utf8");
  return "";
}

function isThrottled({ usagePath, nowMs, minIntervalSec, readFile }) {
  try {
    const data = JSON.parse(readFile(usagePath, "utf8"));
    const writtenAt = Number(data?.writtenAt);
    return Number.isFinite(writtenAt) && Math.floor(nowMs / 1000) - writtenAt < minIntervalSec;
  } catch {
    return false;
  }
}

function isAttemptThrottled({ attemptState, nowSec, minIntervalSec }) {
  const lastAttemptSec = Number(attemptState?.lastAttemptSec);
  return Number.isFinite(lastAttemptSec) && lastAttemptSec > 0 && nowSec - lastAttemptSec < minIntervalSec;
}

function markAttempt(attemptState, nowSec) {
  if (attemptState && typeof attemptState === "object") {
    attemptState.lastAttemptSec = nowSec;
  }
}

export function writeUsageFile(
  path,
  out,
  {
    mkdir = mkdirSync,
    writeFile = writeFileSync,
    rename = renameSync,
    pid = process.pid,
    randomId = randomUUID,
  } = {},
) {
  mkdir(dirname(path), { recursive: true });
  const tmp = usageTmpPath(path, { pid, randomId });
  writeFile(tmp, JSON.stringify(out));
  rename(tmp, path);
}

export function usageTmpPath(path, { pid = process.pid, randomId = randomUUID } = {}) {
  return `${path}.${pid}.${randomId()}.tmp`;
}

function defaultTimeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), ms);
  timer.unref?.();
  return controller.signal;
}

function numOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoToEpoch(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
