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
- **Except when the remote tip is the commit this machine published.** Then
  nobody else has had the device since, the local save is that commit's
  continuation, and pulling would roll it back to whenever the last push
  happened. This is not a corner case: the push is debounced by minutes, and
  every USB unplug/replug drops the transport to mock and back — which is a
  re-attach, and therefore a pull. Without the guard, reseating a cable
  silently reverts an hour's bond credit. The commit we published is recorded
  in `state.json.sync`; no marker means "never published from here", which
  correctly makes any remote tip look like someone else's.
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
node scripts/save-sync-cli.mjs status   # both saves, and which way to sync
node scripts/save-sync-cli.mjs pull     # replace the local one with the remote's
```

`status` fetches and prints the remote's save next to the local one, then says
which direction applies:

```
remote : save/main
         Hughie (bulbasaur) Lv.14 exp=8.27 bond=17.2 streak=4
local  : Hughie (bulbasaur) Lv.14 exp=8.27 bond=17.2 streak=4
         → already the same save, nothing to do
```

It writes nothing — not the save, not the `.presync` undo copy. The only thing
it changes is the remote-tracking ref the fetch updates, which is inside `.git`
and not the save. Pulling stays a separate, deliberate command because it is the
destructive one.

The verdict line distinguishes the case that actually costs you a buddy: if the
remote tip is *this machine's own* publish, the local save is that commit's
continuation and pulling would roll it back, so status says do not pull. That is
the same marker test `pull()` itself makes (`state.json.sync`).

**Before 2026-07-29 `status` printed only the remote's *name*** and no part of
its contents, which made the handoff's "stop if the remote is behind this
machine" instruction impossible to actually follow.

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
