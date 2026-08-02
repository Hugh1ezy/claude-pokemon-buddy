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

// peek() is what `save-sync-cli.mjs status` prints. It is the command the
// handoff tells the other machine to run BEFORE deciding whether to pull, so
// the one property that matters more than what it reports is that it changes
// nothing while reporting it.
test("peek reports the remote save without touching the local one", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  const git = fakeGit({ blob: JSON.stringify(OTHER), tip: "aaa111" });

  const result = await createSaveSync({ statePath, runGit: git.run, logger: null }).peek();

  assert.equal(result.status, "ok");
  assert.deepEqual(result.save, OTHER);
  assert.equal(result.identical, false);
  assert.equal(result.ours, false);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), SAVE);
  assert.ok(!existsSync(`${statePath}.presync`), "peek must not leave an undo copy");
});

test("peek marks a remote tip this machine published as ours, so status can say do-not-pull", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  const git = fakeGit({ blob: JSON.stringify(OTHER), tip: "aaa111", tipTree: "old-tree" });
  const sync = createSaveSync({ statePath, runGit: git.run, logger: null });

  assert.equal((await sync.push()).status, "pushed");
  git.setTip("commit-sha");

  const result = await sync.peek();

  assert.equal(result.ours, true);
  // Same call on a tip from the other machine, to pin that `ours` tracks the
  // marker and is not just "we have pushed at some point".
  git.setTip("someone-elses-commit");
  assert.equal((await sync.peek()).ours, false);
});

test("peek calls a byte-identical remote identical, which is what status prints as nothing to do", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  const git = fakeGit({ blob: JSON.stringify(SAVE), tip: "aaa111" });

  assert.equal((await createSaveSync({ statePath, runGit: git.run, logger: null }).peek()).identical, true);
});

test("peek reports a branch that does not exist yet as the first run it is", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  const git = fakeGit({ fetchFails: "fatal: couldn't find remote ref refs/heads/cpb-save" });

  assert.equal((await createSaveSync({ statePath, runGit: git.run, logger: null }).peek()).status, "no-remote-save");
});

test("no git command may touch the working tree, HEAD, or the index", async (t) => {
  const { statePath } = tempSave(t, SAVE);
  const git = fakeGit({ blob: JSON.stringify(OTHER), tip: "aaa111", tipTree: "old-tree" });
  const sync = createSaveSync({ statePath, runGit: git.run, logger: null });

  await sync.pull();
  await sync.push();
  await sync.peek();

  const forbidden = new Set([
    "checkout", "switch", "reset", "add", "commit", "merge", "rebase", "stash", "clean", "restore",
  ]);
  for (const call of git.calls) {
    assert.ok(!forbidden.has(call[0]), `save-sync must not run "git ${call[0]}"`);
  }
});

// ── 2026-08-03: the weekend that was overwritten ────────────────────────────
// A host that had been up for three days, with the device elsewhere the whole
// time, force-pushed its stale save over the other machine's. Nine catches and
// nine dex entries went with it. The lease said yes because the lease only ever
// answers "did anyone push in the last few milliseconds". These pin the two
// checks that would have said no. Counts only, never species -- CLAUDE.md.

const COLLECTED = {
  schemaVersion: 1, hatched: true, species: "abra", level: 11, streak: 8,
  dexCaught: ["s1", "s2", "s3", "s4"], capturedCount: 4,
  box: [{ species: "s2", level: 5 }, { species: "s3", level: 6 }],
};
const STALE = {
  schemaVersion: 1, hatched: true, species: "abra", level: 11, streak: 9,
  dexCaught: ["s1", "s2"], capturedCount: 2,
  box: [{ species: "s2", level: 5 }],
};

test("push refuses to publish over a remote holding catches this machine does not have", async (t) => {
  const { statePath } = tempSave(t, STALE);
  const git = fakeGit({ blob: JSON.stringify(COLLECTED), tip: "aaa111", tipTree: "old-tree" });

  const result = await createSaveSync({ statePath, runGit: git.run, logger: null }).push();

  assert.equal(result.status, "push-would-lose");
  assert.ok(!git.calls.some((call) => call[0] === "push"), "nothing may reach the remote");
  // The reason reaches a log the owner reads, so it carries counts and no names.
  assert.match(result.detail, /2 dex entries and 2 captures/);
  assert.ok(!/s1|s2|s3|s4|abra/.test(result.detail), "the refusal must not name a species");
});

test("allowLoss is the escape hatch for a removal that was deliberate", async (t) => {
  const { statePath } = tempSave(t, STALE);
  const git = fakeGit({ blob: JSON.stringify(COLLECTED), tip: "aaa111", tipTree: "old-tree" });

  const result = await createSaveSync({ statePath, runGit: git.run, logger: null }).push({ allowLoss: true });

  assert.equal(result.status, "pushed");
});

test("a save that is merely different, not behind, still publishes", async (t) => {
  const { statePath } = tempSave(t, { ...COLLECTED, bond: 3 });
  const git = fakeGit({ blob: JSON.stringify(COLLECTED), tip: "aaa111", tipTree: "old-tree" });

  assert.equal((await createSaveSync({ statePath, runGit: git.run, logger: null }).push()).status, "pushed");
});

test("pull takes the remote's lineage but keeps 图鉴/捕捉 only this machine has", async (t) => {
  // The device's holder owns level/exp/bond. The collection is monotone and the
  // non-holder cannot have caught anything, so the union is exact, not a guess.
  const local = { ...STALE, level: 4, dexCaught: ["s1", "s2", "s9"], capturedCount: 3, box: [{ species: "s9", level: 2 }] };
  const { statePath } = tempSave(t, local);
  const git = fakeGit({ blob: JSON.stringify(COLLECTED), tip: "aaa111" });

  const result = await createSaveSync({ statePath, runGit: git.run, logger: null }).pull();

  assert.equal(result.status, "pulled");
  assert.equal(result.keptLocal, 2, "one dex entry and one box entry were local-only");
  const after = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(after.level, 11, "level comes wholesale from whoever had the device");
  assert.equal(after.streak, 8);
  assert.deepEqual(after.dexCaught, ["s1", "s2", "s3", "s4", "s9"]);
  assert.deepEqual(after.box.map((entry) => entry.species), ["s2", "s3", "s9"]);
  assert.equal(after.capturedCount, 4, "max of the two, never a sum -- they share an ancestor");
  // The undo copy is still the untouched local save, not the merge.
  assert.deepEqual(JSON.parse(readFileSync(`${statePath}.presync`, "utf8")), local);
});

test("a pull with nothing local-only installs the remote save byte for byte", async (t) => {
  const { statePath } = tempSave(t, STALE);
  const git = fakeGit({ blob: JSON.stringify(COLLECTED), tip: "aaa111" });

  const result = await createSaveSync({ statePath, runGit: git.run, logger: null }).pull();

  assert.equal(result.keptLocal, 0);
  assert.equal(readFileSync(statePath, "utf8"), JSON.stringify(COLLECTED));
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
