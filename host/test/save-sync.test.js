import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSaveSync } from "../src/save-sync.js";

const SAVE = { schemaVersion: 1, hatched: true, species: "bulbasaur", level: 9, streak: 3 };
const OTHER = { schemaVersion: 1, hatched: true, species: "bulbasaur", level: 12, streak: 6 };

test("pull installs the remote save and leaves a one-step undo behind", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  const git = fakeGit({ blob: JSON.stringify(OTHER), tip: "aaa111" });

  const result = await createSaveSync({ statePath, runGit: git.run, logger: null }).pull();

  assert.equal(result.status, "pulled");
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), OTHER);
  // The undo copy is deliberately NOT state.json.bak -- loadState falls back to
  // that one, so a pull must not consume it.
  assert.deepEqual(JSON.parse(readFileSync(`${statePath}.presync`, "utf8")), SAVE);
  assert.ok(!existsSync(`${statePath}.bak`));
});

test("pull keeps the local save when the remote blob is not a usable save", async (t) => {
  for (const blob of ["", "not json", "{}", JSON.stringify({ hatched: true })]) {
    const { statePath } = tempSave(t, SAVE);
    const git = fakeGit({ blob, tip: "aaa111" });

    const result = await createSaveSync({ statePath, runGit: git.run, logger: null }).pull();

    assert.equal(result.status, "remote-save-invalid", `blob ${JSON.stringify(blob)}`);
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), SAVE);
    assert.ok(!existsSync(`${statePath}.presync`));
  }
});

test("pull is a no-op when the remote save is byte-identical", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  const git = fakeGit({ blob: JSON.stringify(SAVE), tip: "aaa111" });

  const result = await createSaveSync({ statePath, runGit: git.run, logger: null }).pull();

  assert.equal(result.status, "already-current");
  assert.ok(!existsSync(`${statePath}.presync`));
});

test("a branch that does not exist yet is a normal first run, not a failure", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  const git = fakeGit({ fetchFails: "fatal: couldn't find remote ref refs/heads/cpb-save" });

  const sync = createSaveSync({ statePath, runGit: git.run, logger: null });

  assert.equal((await sync.pull()).status, "no-remote-save");
  assert.equal((await sync.push()).status, "pushed");
  // No tip to pin a lease to, so the create is a plain push.
  const push = git.calls.find((call) => call[0] === "push");
  assert.deepEqual(push, ["push", "origin", "commit-sha:refs/heads/cpb-save"]);
});

test("push replaces the tip with a parentless commit, leased to the tip it saw", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  const git = fakeGit({ blob: JSON.stringify(OTHER), tip: "aaa111", tipTree: "old-tree" });

  const result = await createSaveSync({ statePath, runGit: git.run, logger: null }).push();

  assert.equal(result.status, "pushed");
  const commit = git.calls.find((call) => call[0] === "commit-tree");
  assert.ok(commit, "expected a commit-tree call");
  assert.ok(!commit.includes("-p"), "the save branch must stay one commit deep");
  assert.deepEqual(git.calls.find((call) => call[0] === "push"), [
    "push",
    "--force-with-lease=refs/heads/cpb-save:aaa111",
    "origin",
    "commit-sha:refs/heads/cpb-save",
  ]);
});

test("push skips the network when the remote already holds this exact save", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  const git = fakeGit({ blob: JSON.stringify(SAVE), tip: "aaa111", tipTree: "tree-sha" });

  const result = await createSaveSync({ statePath, runGit: git.run, logger: null }).push();

  assert.equal(result.status, "already-current");
  assert.ok(!git.calls.some((call) => call[0] === "push"));
});

test("a lease failure is reported as a rejection, never retried as a force", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  const git = fakeGit({
    blob: JSON.stringify(OTHER),
    tip: "aaa111",
    tipTree: "old-tree",
    pushFails: "! [rejected] stale info",
  });

  const result = await createSaveSync({ statePath, runGit: git.run, logger: null }).push();

  assert.equal(result.status, "push-rejected");
  assert.equal(git.calls.filter((call) => call[0] === "push").length, 1);
});

test("push refuses to publish a local save it cannot parse", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  writeFileSync(statePath, "{truncated");
  const git = fakeGit({ tip: "aaa111" });

  const result = await createSaveSync({ statePath, runGit: git.run, logger: null }).push();

  assert.equal(result.status, "local-save-invalid");
  assert.equal(git.calls.length, 0);
});

test("maybePush debounces on the interval and a rejection does not start the clock", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  const git = fakeGit({ blob: JSON.stringify(OTHER), tip: "aaa111", tipTree: "old-tree" });
  let clock = new Date("2026-07-28T09:00:00Z");
  const sync = createSaveSync({
    statePath, runGit: git.run, logger: null, pushIntervalMs: 60_000, now: () => clock,
  });

  assert.equal((await sync.maybePush()).status, "pushed");
  clock = new Date("2026-07-28T09:00:30Z");
  assert.equal((await sync.maybePush()).status, "debounced");
  clock = new Date("2026-07-28T09:01:30Z");
  assert.equal((await sync.maybePush()).status, "pushed");

  // force is what shutdown uses: "in 5 minutes" would mean never.
  clock = new Date("2026-07-28T09:01:40Z");
  assert.equal((await sync.maybePush({ force: true })).status, "pushed");

  git.setPushFails("! [rejected] stale info");
  clock = new Date("2026-07-28T09:10:00Z");
  assert.equal((await sync.maybePush()).status, "push-rejected");
  clock = new Date("2026-07-28T09:10:05Z");
  // Still inside the interval, but the last attempt never landed -- retry.
  assert.equal((await sync.maybePush()).status, "push-rejected");
});

test("a pull will not roll back over the tip this machine itself published", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  const git = fakeGit({ blob: JSON.stringify(OTHER), tip: "aaa111", tipTree: "old-tree" });
  const sync = createSaveSync({ statePath, runGit: git.run, logger: null });

  assert.equal((await sync.push()).status, "pushed");
  // The remote now holds our own commit. Local has moved on since (the push is
  // debounced, and a USB reseat re-attaches the transport and triggers a pull).
  git.setTip("commit-sha");
  writeFileSync(statePath, JSON.stringify({ ...SAVE, bondHalves: 1 }));

  const result = await sync.pull();

  assert.equal(result.status, "ours-already");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).bondHalves, 1);
  assert.ok(!existsSync(`${statePath}.presync`), "nothing should have been replaced");
});

test("a pull still takes a tip that came from the other machine", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  const git = fakeGit({ blob: JSON.stringify(OTHER), tip: "aaa111", tipTree: "old-tree" });
  const sync = createSaveSync({ statePath, runGit: git.run, logger: null });

  assert.equal((await sync.push()).status, "pushed");
  git.setTip("someone-elses-commit");   // the other machine published since

  assert.equal((await sync.pull()).status, "pulled");
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), OTHER);
});

test("with no marker yet, the very first pull still takes the remote", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  const git = fakeGit({ blob: JSON.stringify(OTHER), tip: "aaa111" });

  assert.equal((await createSaveSync({ statePath, runGit: git.run, logger: null }).pull()).status, "pulled");
});

test("no git command may touch the working tree, HEAD, or the index", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  const git = fakeGit({ blob: JSON.stringify(OTHER), tip: "aaa111", tipTree: "old-tree" });
  const sync = createSaveSync({ statePath, runGit: git.run, logger: null });

  await sync.pull();
  await sync.push();

  const forbidden = new Set([
    "checkout", "switch", "reset", "add", "commit", "merge", "rebase", "stash", "clean", "restore",
  ]);
  for (const call of git.calls) {
    assert.ok(!forbidden.has(call[0]), `save-sync must not run "git ${call[0]}"`);
  }
});

function tempSave(t, save) {
  const dir = mkdtempSync(join(tmpdir(), "cpb-save-sync-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify(save));
  return { dir, statePath };
}

// Scripts just enough of git's surface to drive save-sync, and records every
// invocation so the tests can assert on what was NOT run as well as what was.
function fakeGit({ blob = null, tip = null, tipTree = "old-tree", fetchFails = null, pushFails = null } = {}) {
  const calls = [];
  let currentPushFails = pushFails;
  let currentTip = tip;

  const run = async (args) => {
    calls.push(args);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const err = (stderr) => ({ code: 1, stdout: "", stderr });

    switch (args[0]) {
      case "fetch":
        return fetchFails ? err(fetchFails) : ok();
      case "show":
        return blob == null ? err("fatal: path does not exist") : ok(blob);
      case "hash-object":
        return ok("blob-sha\n");
      case "mktree":
        return ok("tree-sha\n");
      case "rev-parse":
        if (fetchFails) return err("fatal: bad revision");
        return args[1].endsWith("^{tree}") ? ok(`${tipTree}\n`) : ok(`${currentTip}\n`);
      case "commit-tree":
        return ok("commit-sha\n");
      case "push":
        return currentPushFails ? err(currentPushFails) : ok();
      default:
        return err(`unexpected: git ${args.join(" ")}`);
    }
  };

  return {
    run,
    calls,
    setPushFails: (value) => { currentPushFails = value; },
    setTip: (value) => { currentTip = value; },
  };
}
