// Keeps one save following the device across the machines that take turns
// driving it. `out/state.json` is gitignored on purpose -- it is per-machine
// runtime data, not source -- so this rides a dedicated branch instead of the
// working tree.
//
// Three properties are what make it safe to run from inside the tick loop:
//
// 1. Plumbing only (hash-object / mktree / commit-tree / push <sha>:<ref>).
//    Nothing here checks out, switches branches, stages, or touches HEAD, so
//    it cannot disturb a working tree someone is editing at the same time.
// 2. Every push is a PARENTLESS commit that replaces the branch tip, so the
//    branch stays exactly one commit deep no matter how many years of saves
//    go through it.
// 3. Pushes use --force-with-lease pinned to the tip we last saw. If the other
//    machine pushed in the meantime, the push is REJECTED rather than winning
//    -- losing a save to a silent overwrite is the one outcome worth failing
//    loudly over.
//
// The caller is responsible for the fourth property, and it is the important
// one: only push from the machine that currently has the device attached (see
// index.js). A host running in mock mode is simulating a buddy nobody is
// looking at; letting it publish would overwrite the real one.
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

export const DEFAULT_BRANCH = "cpb-save";
export const DEFAULT_PUSH_INTERVAL_MS = 5 * 60_000;
const BLOB_NAME = "state.json";

export function createSaveSync({
  statePath,
  remote = "origin",
  branch = DEFAULT_BRANCH,
  cwd,
  runGit = defaultRunGit,
  logger = console,
  now = () => new Date(),
  pushIntervalMs = DEFAULT_PUSH_INTERVAL_MS,
  machine = hostname(),
} = {}) {
  if (!statePath) throw new Error("createSaveSync requires statePath");

  const git = (args, options) => runGit(args, { cwd, ...options });
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  let lastPushAt = null;

  return { pull, push, maybePush, describe };

  function describe() {
    return { remote, branch, statePath };
  }

  // Fetches the remote save and installs it locally. Returns a status rather
  // than throwing: a sync failure must never take the host down with it.
  async function pull() {
    const fetched = await fetchRemote();
    if (fetched.status !== "ok") return fetched;

    const shown = await git(["show", `${remoteRef}:${BLOB_NAME}`]);
    if (shown.code !== 0) {
      return fail("remote-save-unreadable", shown.stderr);
    }

    const remoteText = shown.stdout;
    if (!parseSave(remoteText)) {
      // A save we cannot parse is not a save. Keep whatever is on this machine.
      return fail("remote-save-invalid", "remote blob is not a usable save");
    }

    const localText = existsSync(statePath) ? readFileSync(statePath, "utf8") : null;
    if (localText === remoteText) return { status: "already-current" };

    // One-step undo, kept separate from state.json.bak so a pull can never
    // consume the backup loadState() falls back to.
    if (localText != null) copyFileSync(statePath, `${statePath}.presync`);

    const tmp = `${statePath}.pull.tmp`;
    writeFileSync(tmp, remoteText, "utf8");
    renameSync(tmp, statePath);
    logger?.warn?.(`save-sync: pulled save from ${remote}/${branch}`);
    return { status: "pulled" };
  }

  // Publishes the local save. `force` skips the interval debounce (used on
  // shutdown, where "in 5 minutes" means never).
  async function maybePush({ force = false } = {}) {
    const stamp = now();
    if (!force && lastPushAt != null && stamp - lastPushAt < pushIntervalMs) {
      return { status: "debounced" };
    }
    const result = await push();
    // Only a completed attempt restarts the clock; a rejected push should be
    // retried on the next tick, not sat on for another interval.
    if (result.status === "pushed" || result.status === "already-current") lastPushAt = stamp;
    return result;
  }

  async function push() {
    if (!existsSync(statePath)) return { status: "no-local-save" };
    const localText = readFileSync(statePath, "utf8");
    if (!parseSave(localText)) {
      return fail("local-save-invalid", "refusing to publish an unparseable save");
    }

    const blob = await git(["hash-object", "-w", "--path", BLOB_NAME, "--", statePath]);
    if (blob.code !== 0) return fail("hash-object-failed", blob.stderr);

    const tree = await git(["mktree"], { input: `100644 blob ${trim(blob.stdout)}\t${BLOB_NAME}\n` });
    if (tree.code !== 0) return fail("mktree-failed", tree.stderr);
    const treeSha = trim(tree.stdout);

    const fetched = await fetchRemote();
    if (fetched.status === "fetch-failed") return fetched;

    let expected = null;
    if (fetched.status === "ok") {
      const tip = await git(["rev-parse", remoteRef]);
      if (tip.code === 0) {
        expected = trim(tip.stdout);
        const tipTree = await git(["rev-parse", `${expected}^{tree}`]);
        if (tipTree.code === 0 && trim(tipTree.stdout) === treeSha) {
          return { status: "already-current" };
        }
      }
    }

    const message = `cpb save from ${machine} at ${now().toISOString()}`;
    const commit = await git(["commit-tree", treeSha, "-m", message]);
    if (commit.code !== 0) return fail("commit-tree-failed", commit.stderr);
    const commitSha = trim(commit.stdout);

    const refspec = `${commitSha}:refs/heads/${branch}`;
    const args = expected
      ? ["push", `--force-with-lease=refs/heads/${branch}:${expected}`, remote, refspec]
      : ["push", remote, refspec];
    const pushed = await git(args);
    if (pushed.code !== 0) {
      // A lease failure means the other machine published while we were away.
      // Say so specifically -- it is the one case where the user has to choose.
      const rejected = /stale info|non-fast-forward|rejected/i.test(pushed.stderr);
      return fail(rejected ? "push-rejected" : "push-failed", pushed.stderr);
    }
    return { status: "pushed" };
  }

  async function fetchRemote() {
    const result = await git([
      "fetch", "--quiet", remote, `+refs/heads/${branch}:${remoteRef}`,
    ]);
    if (result.code === 0) return { status: "ok" };
    // A branch that does not exist yet is the normal first-run state, not an
    // error -- the first push creates it.
    if (/couldn't find remote ref|does not appear to be a git repository/i.test(result.stderr)) {
      return { status: "no-remote-save" };
    }
    return fail("fetch-failed", result.stderr);
  }

  function fail(status, detail) {
    logger?.warn?.(`save-sync: ${status}${detail ? ` -- ${firstLine(detail)}` : ""}`);
    return { status, detail };
  }
}

function parseSave(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    // Deliberately weak: enough to tell a save from a truncated file or an
    // error page, without duplicating state.js's normalization rules here.
    if (value.hatched !== true || typeof value.species !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

function trim(text) {
  return String(text ?? "").trim();
}

function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0];
}

function defaultRunGit(args, { cwd, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        // Never let git stop and wait for a credential prompt: this runs from a
        // background host with no console attached to answer it.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? String(error?.message ?? "") });
      },
    );
    if (input != null) child.stdin?.end(input);
  });
}
