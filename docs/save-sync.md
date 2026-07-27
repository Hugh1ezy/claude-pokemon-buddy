# Save sync (optional)

One buddy that follows the device between machines. Off unless
`host/config.json` opts in.

## The problem it solves

`host/out/state.json` is the save, and `out/` is gitignored — deliberately,
because it is per-machine runtime data, not source. So a `git pull` moves the
code between the home and work hosts and leaves the save behind, and each
machine quietly raises its own buddy. Plug the same device in at both places
and it shows a different level, streak and bond depending on where you are.

## The model: the machine holding the device owns the save

This is the whole design, and everything else follows from it.

Only a host with a device actually attached (`transport.getKind()` is
`serial` or `wifi`, not mock) publishes. A host running in mock mode is
simulating a buddy nobody is looking at — it still ticks, settles days and
accrues growth, and all of that is drift that must never reach the other
machine. So:

- **On host start**, and again **the moment a device attaches** to a host that
  was idling in mock mode, the save is pulled. That second pull is the one
  that matters: it is what stops the machine you just walked back to from
  publishing the stale copy it invented while the device was elsewhere.
  (`loadState` re-reads from disk every tick, so replacing the file is all the
  handoff takes — nothing in the loop caches the pet.)
- **While a device is attached**, the save is pushed at most every
  `pushIntervalMs` (default 5 minutes), plus once on shutdown if the device is
  still attached at that moment.

## How it rides git without touching your repo

`host/src/save-sync.js` uses plumbing only — `hash-object`, `mktree`,
`commit-tree`, and `push <sha>:<ref>`. It never runs `checkout`, `switch`,
`reset`, `add`, `commit`, `merge`, `stash` or `restore`; HEAD, the index and
the working tree are untouched. That is what makes it safe to run from inside
the tick loop while you have the repo open and are editing code
(`host/test/save-sync.test.js` asserts the forbidden verbs are never invoked).

Every push is a **parentless** commit that replaces the branch tip, so the
save branch stays exactly one commit deep forever instead of accumulating a
commit per push.

Pushes use `--force-with-lease` pinned to the tip that was just fetched. If
the other machine published while this one was away, the push is **rejected**
and logged rather than winning. Losing a save to a silent overwrite is the one
failure worth being loud about; the fix is to decide which buddy you want and
run the CLI below by hand.

A pull refuses anything that does not parse as a save (`hatched: true` plus a
`species` string), and copies the file it is about to replace to
`state.json.presync` first. That is deliberately **not** `state.json.bak` —
`loadState` falls back to `.bak`, so a pull must not consume it.

## Setup

The save is not secret, but it is not source either, and the code fork is
public — so this wants its own small **private** repo rather than a branch on
the fork.

```powershell
gh repo create <you>/cpb-save --private
cd "$HOME\claude-pokemon-buddy"
git remote add save https://github.com/<you>/cpb-save.git
```

Then add the block to `host/config.json` (gitignored, so this is per-machine —
both machines need it, pointing at the same repo):

```json
"saveSync": {
  "enabled": true,
  "remote": "save",
  "branch": "main",
  "pushIntervalMs": 300000
}
```

Bootstrap from whichever machine currently holds the buddy you want to keep:

```powershell
cd "$HOME\claude-pokemon-buddy\host"
node scripts/save-sync-cli.mjs push
```

On the other machine, `pull` before its host next runs — that machine's own
save is overwritten, so check what you are about to lose first:

```powershell
node scripts/save-sync-cli.mjs status   # what is local right now
node scripts/save-sync-cli.mjs pull     # replace it with the remote's
```

`status` / `pull` / `push` are the whole CLI. It reads the same config block
and reports the same statuses the host logs.

## Git credentials

The host runs unattended, so `GIT_TERMINAL_PROMPT=0` is forced on every git
call: a missing credential fails fast and gets logged instead of hanging the
tick loop forever on a prompt nobody can answer. On Windows the credential
manager already has the token if you have ever pushed from that machine;
verify with `git ls-remote save` before trusting it.

## What it does not do

- **No merging.** A save is taken whole or not at all. Two machines that both
  raised progress cannot be reconciled — the lease rejection tells you it
  happened and you pick a winner.
- **No conflict resolution across a lost push.** If the network was down for
  the last stretch of a session, that stretch is lost when the other machine
  publishes next. The push-on-shutdown is what keeps that window small.
- **Nothing but the save.** `config.json`, `wifi_creds.h` and
  `start-buddy.vbs` stay per-machine on purpose (see `docs/handoff.md`).
