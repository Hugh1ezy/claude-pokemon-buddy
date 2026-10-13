import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ccVersion,
  fetchUsage,
  pollUsageOnce,
  readOAuthToken,
  toUsageFileShape,
  writeUsageFile,
} from "../src/usage-poll.mjs";

const OUT_DIR = fileURLToPath(new URL("../out", import.meta.url));
const FAKE_HOME = join(OUT_DIR, "fake-home");
const NOW_MS = 1_750_000_123_456;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const FIVE_HOUR_RESET_ISO = "2026-06-17T03:04:05.000Z";
const WEEKLY_RESET_ISO = "2026-06-20T06:07:08.000Z";

function tempUsagePath(t) {
  mkdirSync(OUT_DIR, { recursive: true });
  const dir = mkdtempSync(join(OUT_DIR, "test-usage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "cpb-usage.json");
}

function usageResp() {
  return {
    five_hour: { utilization: 34.2, resets_at: FIVE_HOUR_RESET_ISO },
    seven_day: { utilization: 78.9, resets_at: WEEKLY_RESET_ISO },
  };
}

function fetchUsageOk(data = usageResp()) {
  return { status: 200, data };
}

function attemptState() {
  return { lastAttemptSec: 0 };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("readOAuthToken reads macOS keychain JSON accessToken", () => {
  const token = readOAuthToken({
    platform: "darwin",
    exec: (command, args) => {
      assert.equal(command, "security");
      assert.deepEqual(args, ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
      return JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } });
    },
  });
  assert.equal(token, "keychain-token");
});

test("readOAuthToken reads file credentials on non-macOS platforms", () => {
  for (const platform of ["win32", "linux"]) {
    const token = readOAuthToken({
      platform,
      home: FAKE_HOME,
      readFile: (path, encoding) => {
        assert.equal(path, join(FAKE_HOME, ".claude", ".credentials.json"));
        assert.equal(encoding, "utf8");
        return JSON.stringify({ claudeAiOauth: { accessToken: `${platform}-token` } });
      },
    });
    assert.equal(token, `${platform}-token`);
  }
});

test("readOAuthToken returns null when credentials cannot be read or parsed", () => {
  assert.equal(readOAuthToken({ platform: "darwin", exec: () => { throw new Error("no keychain"); } }), null);
  assert.equal(readOAuthToken({ platform: "linux", home: FAKE_HOME, readFile: () => "not json" }), null);
});

test("ccVersion parses claude semver and falls back on failure", () => {
  assert.equal(ccVersion({ exec: () => "Claude Code 2.3.4" }), "2.3.4");
  assert.equal(ccVersion({ exec: () => { throw new Error("missing"); } }), "2.1.0");
});

test("toUsageFileShape maps official usage response to cpb usage file shape", () => {
  const shaped = toUsageFileShape(usageResp(), NOW_MS);
  assert.deepEqual(shaped, {
    fiveHourPct: 34.2,
    fiveHourReset: Math.floor(Date.parse(FIVE_HOUR_RESET_ISO) / 1000),
    weeklyPct: 78.9,
    weeklyReset: Math.floor(Date.parse(WEEKLY_RESET_ISO) / 1000),
    writtenAt: NOW_SEC,
  });
});

test("toUsageFileShape uses nulls for missing usage fields and resets", () => {
  const shaped = toUsageFileShape({ five_hour: { utilization: 12 } }, NOW_MS);
  assert.deepEqual(shaped, {
    fiveHourPct: 12,
    fiveHourReset: null,
    weeklyPct: null,
    weeklyReset: null,
    writtenAt: NOW_SEC,
  });
});

test("fetchUsage calls official endpoint with OAuth headers and returns JSON", async () => {
  const body = usageResp();
  let request;
  const result = await fetchUsage("oauth-token", {
    version: "2.3.4",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { status: 200, json: async () => body };
    },
  });
  assert.deepEqual(result, { status: 200, data: body });
  assert.equal(request.url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.headers.Authorization, "Bearer oauth-token");
  assert.equal(request.init.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(request.init.headers["User-Agent"], "claude-code/2.3.4");
  assert.equal(request.init.headers["Content-Type"], "application/json");
});

test("fetchUsage returns HTTP status on non-200 responses and null on thrown fetches", async () => {
  assert.deepEqual(await fetchUsage("token", { version: "2.3.4", fetchImpl: async () => ({ status: 429 }) }), { status: 429, data: null });
  assert.deepEqual(await fetchUsage("token", { version: "2.3.4", fetchImpl: async () => ({ status: 401 }) }), { status: 401, data: null });
  assert.equal(await fetchUsage("token", { version: "2.3.4", fetchImpl: async () => { throw new Error("network"); } }), null);
});

test("pollUsageOnce aborts hung official usage fetch and keeps degraded last-known file", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const usagePath = tempUsagePath(t);
  const existing = { fiveHourPct: 11, weeklyPct: 22, writtenAt: NOW_SEC - 181 };
  writeFileSync(usagePath, JSON.stringify(existing));
  let sawSignal = false;
  let settled = false;

  const pending = pollUsageOnce({
    usagePath,
    now: NOW_MS,
    readOAuthTokenImpl: () => "token",
    ccVersionImpl: () => "2.3.4",
    fetchImpl: async (_url, init = {}) => {
      sawSignal = init.signal instanceof AbortSignal;
      if (!init.signal) throw new Error("missing timeout signal");
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
    timeoutSignal: timeoutSignalFactory(),
    attemptState: attemptState(),
  }).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();

  assert.equal(sawSignal, true);
  assert.equal(settled, false);
  t.mock.timers.tick(9_999);
  await Promise.resolve();
  assert.equal(settled, false);

  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { ok: false, reason: "fetch-failed" });
  assert.deepEqual(readJson(usagePath), existing);
});

test("usage file writes use per-writer tmp names and publish parseable JSON", (t) => {
  const usagePath = tempUsagePath(t);
  const files = new Map();
  const tmpWrites = [];
  const randomIds = ["poll", "bridge"];
  let randomCalls = 0;
  const io = {
    mkdir() {},
    writeFile(path, body) {
      tmpWrites.push(path);
      files.set(path, body);
    },
    rename(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
    pid: 12345,
    randomId: () => randomIds[randomCalls++],
  };

  writeUsageFile(usagePath, { writer: "poll" }, io);
  writeUsageFile(usagePath, { writer: "bridge" }, io);

  assert.deepEqual(tmpWrites, [
    `${usagePath}.12345.poll.tmp`,
    `${usagePath}.12345.bridge.tmp`,
  ]);
  assert.deepEqual(JSON.parse(files.get(usagePath)), { writer: "bridge" });
});

test("pollUsageOnce skips network when existing usage file is inside throttle window", async (t) => {
  const usagePath = tempUsagePath(t);
  const existing = { fiveHourPct: 11, weeklyPct: 22, writtenAt: NOW_SEC - 60 };
  writeFileSync(usagePath, JSON.stringify(existing));

  let fetchCalls = 0;
  const result = await pollUsageOnce({
    usagePath,
    now: NOW_MS,
    minIntervalSec: 180,
    readOAuthTokenImpl: () => "token",
    fetchUsageImpl: async () => {
      fetchCalls += 1;
      return fetchUsageOk();
    },
    attemptState: attemptState(),
  });

  assert.deepEqual(result, { ok: true, skipped: true });
  assert.equal(fetchCalls, 0);
  assert.deepEqual(readJson(usagePath), existing);
});

test("pollUsageOnce calls fetch and writes usage file when no throttle file exists", async (t) => {
  const usagePath = tempUsagePath(t);
  let fetchCalls = 0;

  const result = await pollUsageOnce({
    usagePath,
    now: NOW_MS,
    minIntervalSec: 180,
    readOAuthTokenImpl: () => "token",
    ccVersionImpl: () => "2.3.4",
    fetchUsageImpl: async (token, { version }) => {
      fetchCalls += 1;
      assert.equal(token, "token");
      assert.equal(version, "2.3.4");
      return fetchUsageOk();
    },
    attemptState: attemptState(),
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(fetchCalls, 1);
  assert.deepEqual(readJson(usagePath), toUsageFileShape(usageResp(), NOW_MS));
});

test("pollUsageOnce calls fetch and writes usage file when existing usage is expired", async (t) => {
  const usagePath = tempUsagePath(t);
  writeFileSync(usagePath, JSON.stringify({ fiveHourPct: 1, weeklyPct: 2, writtenAt: NOW_SEC - 181 }));

  const result = await pollUsageOnce({
    usagePath,
    now: NOW_MS,
    minIntervalSec: 180,
    readOAuthTokenImpl: () => "token",
    fetchUsageImpl: async () => fetchUsageOk(),
    attemptState: attemptState(),
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(readJson(usagePath), toUsageFileShape(usageResp(), NOW_MS));
});

test("pollUsageOnce keeps existing file when token is unavailable", async (t) => {
  const usagePath = tempUsagePath(t);
  const existing = { fiveHourPct: 11, weeklyPct: 22, writtenAt: NOW_SEC - 181 };
  writeFileSync(usagePath, JSON.stringify(existing));

  const result = await pollUsageOnce({
    usagePath,
    now: NOW_MS,
    readOAuthTokenImpl: () => null,
    fetchUsageImpl: async () => fetchUsageOk(),
    attemptState: attemptState(),
  });

  assert.deepEqual(result, { ok: false, reason: "no-token" });
  assert.deepEqual(readJson(usagePath), existing);
});

test("pollUsageOnce keeps existing file and reports status when usage fetch returns non-200", async (t) => {
  const usagePath = tempUsagePath(t);
  const existing = { fiveHourPct: 11, weeklyPct: 22, writtenAt: NOW_SEC - 181 };
  writeFileSync(usagePath, JSON.stringify(existing));

  const result = await pollUsageOnce({
    usagePath,
    now: NOW_MS,
    readOAuthTokenImpl: () => "token",
    fetchUsageImpl: async () => ({ status: 429, data: null }),
    attemptState: attemptState(),
  });

  assert.deepEqual(result, { ok: false, reason: "http-429" });
  assert.deepEqual(readJson(usagePath), existing);
});

test("pollUsageOnce keeps existing file when fetch fails without a response", async (t) => {
  const usagePath = tempUsagePath(t);
  const existing = { fiveHourPct: 11, weeklyPct: 22, writtenAt: NOW_SEC - 181 };
  writeFileSync(usagePath, JSON.stringify(existing));

  const result = await pollUsageOnce({
    usagePath,
    now: NOW_MS,
    readOAuthTokenImpl: () => "token",
    fetchUsageImpl: async () => null,
    attemptState: attemptState(),
  });

  assert.deepEqual(result, { ok: false, reason: "fetch-failed" });
  assert.deepEqual(readJson(usagePath), existing);
});

test("pollUsageOnce skips retry inside minInterval after fetch failure", async (t) => {
  const usagePath = tempUsagePath(t);
  const state = attemptState();
  let fetchCalls = 0;

  const first = await pollUsageOnce({
    usagePath,
    now: NOW_MS,
    minIntervalSec: 180,
    readOAuthTokenImpl: () => "token",
    fetchUsageImpl: async () => {
      fetchCalls += 1;
      return null;
    },
    attemptState: state,
  });
  const second = await pollUsageOnce({
    usagePath,
    now: NOW_MS,
    minIntervalSec: 180,
    readOAuthTokenImpl: () => "token",
    fetchUsageImpl: async () => {
      fetchCalls += 1;
      return fetchUsageOk();
    },
    attemptState: state,
  });

  assert.deepEqual(first, { ok: false, reason: "fetch-failed" });
  assert.deepEqual(second, { ok: true, skipped: true });
  assert.equal(fetchCalls, 1);
});

test("pollUsageOnce retries after failed attempt minInterval elapses", async (t) => {
  const usagePath = tempUsagePath(t);
  const state = attemptState();
  let fetchCalls = 0;

  const first = await pollUsageOnce({
    usagePath,
    now: NOW_MS,
    minIntervalSec: 180,
    readOAuthTokenImpl: () => "token",
    fetchUsageImpl: async () => {
      fetchCalls += 1;
      return null;
    },
    attemptState: state,
  });
  const second = await pollUsageOnce({
    usagePath,
    now: NOW_MS + 181_000,
    minIntervalSec: 180,
    readOAuthTokenImpl: () => "token",
    fetchUsageImpl: async () => {
      fetchCalls += 1;
      return fetchUsageOk();
    },
    attemptState: state,
  });

  assert.deepEqual(first, { ok: false, reason: "fetch-failed" });
  assert.deepEqual(second, { ok: true });
  assert.equal(fetchCalls, 2);
  assert.deepEqual(readJson(usagePath), toUsageFileShape(usageResp(), NOW_MS + 181_000));
});

function timeoutSignalFactory() {
  return (ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("timeout")), ms);
    return controller.signal;
  };
}

test("refreshCredentialsIfNeeded renews a token that is about to expire and keeps unknown fields", async () => {
  const { refreshCredentialsIfNeeded, TOKEN_ENDPOINT } = await import("../src/usage-poll.mjs");
  const now = 1_800_000_000_000;
  const stored = { claudeAiOauth: { accessToken: "old-a", refreshToken: "old-r", expiresAt: now + 60_000, scopes: ["x", "y"], subscriptionType: "pro" }, other: 1 };
  const written = [];
  const calls = [];
  const result = await refreshCredentialsIfNeeded({
    platform: "win32", home: "/h", now,
    readFile: () => JSON.stringify(stored),
    fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { status: 200, json: async () => ({ access_token: "new-a", refresh_token: "new-r", expires_in: 3600 }) }; },
    timeoutSignal: () => undefined,
    mkdir: () => {}, writeFile: (path, text) => written.push({ path, text }), rename: () => {},
  });
  assert.deepEqual(result, { refreshed: true });
  assert.equal(calls[0].url, TOKEN_ENDPOINT);
  assert.equal(calls[0].body.refresh_token, "old-r");
  assert.equal(calls[0].body.scope, "x y");
  const saved = JSON.parse(written[0].text);
  assert.equal(saved.other, 1);
  assert.deepEqual(saved.claudeAiOauth, { accessToken: "new-a", refreshToken: "new-r", expiresAt: now + 3_600_000, scopes: ["x", "y"], subscriptionType: "pro" });
});

test("refreshCredentialsIfNeeded leaves a fresh token and a failed renewal alone", async () => {
  const { refreshCredentialsIfNeeded } = await import("../src/usage-poll.mjs");
  const now = 1_800_000_000_000;
  const file = (expiresAt) => () => JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt } });
  const never = async () => { throw new Error("must not be called"); };
  const writes = [];
  const io = { platform: "win32", home: "/h", now, timeoutSignal: () => undefined, mkdir: () => {}, writeFile: (...a) => writes.push(a), rename: () => {} };
  assert.equal((await refreshCredentialsIfNeeded({ ...io, readFile: file(now + 3_600_000), fetchImpl: never })).reason, "fresh");
  assert.equal((await refreshCredentialsIfNeeded({ ...io, readFile: file(now - 1), fetchImpl: async () => ({ status: 400 }) })).reason, "http-400");
  assert.equal((await refreshCredentialsIfNeeded({ ...io, platform: "darwin", readFile: file(now - 1), fetchImpl: never })).reason, "keychain");
  assert.equal(writes.length, 0);
});
