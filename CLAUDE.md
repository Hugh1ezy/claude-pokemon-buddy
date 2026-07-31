# CLAUDE.md

## The sync cue — one cue, both directions

The owner moves one device between a home PC (`zy948`) and a work PC (`HUGHIE`)
every day. Sync is driven by a spoken cue, in any of these forms:

> 做准备工作 · 做好回家的准备工作 · 做好去单位的准备工作 · 我到家了 · 我到单位了

**Do not try to infer a direction from which phrase was used.** The owner will not
remember a taxonomy, and guessing wrong is how the machines diverge. Every one of
these means the same thing: **make this machine and the other machine agree.**
Reconcile in both directions, every time.

```bash
cd ~/claude-pokemon-buddy
git status                                  # 1. commit anything outstanding
git fetch hugh
git log --oneline HEAD..hugh/main           # 2. anything to take?  -> git pull hugh main
git log --oneline hugh/main..HEAD           # 3. anything to give?  -> git push hugh main
git rev-parse HEAD hugh/main                #    must print the same sha twice
cd host && node scripts/save-sync-cli.mjs push   # 4. or `pull` — see below
```

5. Update `docs/handoff.md`, then **commit and push that too**. An unpushed
   handoff note is worthless.

**Pushing is part of the routine and is pre-authorized — never stop to ask.**
The owner has said explicitly: the two machines going out of sync is the worst
outcome, worse than an unwanted commit. Push without confirming.

For the save: the machine physically holding the device owns it. If the host log
shows the device attached (`device left local-clock mode`), `push`; if not, `pull`.
`pulled` / `pushed` / `ours-already` / `already-current` are all success.

Finally, restart the host if code was pulled, and report each of these
explicitly — `HEAD == hugh/main`, save synced, handoff pushed. If any is not
true, say which. Never summarise as "ready" unless all of them are.

Commit messages go through `-F <file>` or a heredoc, never inline: a message
containing double quotes gets torn apart by PowerShell and lands a *partial*
commit under the wrong message.

## Fetch `hugh`, and never trust a stale tracking ref

`git fetch origin` fetches the **upstream original** and leaves `refs/remotes/hugh/main`
untouched at whatever a previous session left there. It then looks exactly like a
successful fetch. On 2026-07-30 that produced a confident, wrong report that the
work PC had done nothing all day — 23 commits and 4473 lines were sitting on the
fork, pushed at 18:33, and the error only surfaced when a push was rejected.

**`git fetch hugh` by name. Then check the ref's date, not just the diff.** If
`hugh/main` is more than a few minutes old, fetch again before drawing any
conclusion from it.

Related: even a genuinely clean fetch does not mean nothing is missing — the other
machine may never have pushed. If the owner expects a feature that is not in the
tree, find out whether it was ever pushed and say so; do not report the machine as
in sync.

## Remotes — the names are not what you would guess

| Remote | What |
|---|---|
| `hugh` | `Hugh1ezy/claude-pokemon-buddy` — the fork, **public**. All code lives here. Push here. |
| `origin` | `aquamarinz/claude-pokemon-buddy` — upstream original. Never push. |
| `save` | `Hugh1ezy/cpb-save` — **private**, holds only `state.json`. |

There is no `upstream` remote. Comparing local against `origin/main` makes the
tree look ~48 commits ahead and answers nothing — always compare against
`hugh/main`.

**Check this on every machine, it is not carried by git:** `main` shipped tracking
`origin/main`, i.e. the upstream original. A bare `git pull` therefore pulls from
aquamarinz and can never bring over the other machine's work — which is exactly
how a day of work went missing on 2026-07-30. Fixed on `zy948` on 2026-07-30;
`HUGHIE` was still unverified at that time. Verify and fix with:

```bash
git rev-parse --abbrev-ref HEAD@{upstream}   # want: hugh/main
git branch --set-upstream-to=hugh/main main
```

`save-sync-cli.mjs status` reports both saves and which way to sync as of
`986c2c5` (07-30). If you are on older code it prints only the remote's *name* and
cannot answer the question at all — then use `git show save/main:state.json`.

## Two standing content rules

- **Never state how many days a buddy level costs.** The level curve is
  deliberately opaque to the owner.
- **The spoiler files. Read them freely — just never let their contents reach the
  owner.** This has been misread more than once, so plainly: the restriction is
  on **output, not on access**. You may open, edit, regenerate and test
  `host/scripts/gen-encounters.mjs`, `host/seed/encounters.json`,
  `host/scripts/sim-encounters.mjs` and `host/src/pet/capture-tuning.js` whenever
  the work needs it, and you do not need to ask first.

  What must never happen is a species-condition pair, a rarity, a difficulty or
  a sighting list reaching **chat, commit messages, `docs/`, test names, or
  log output the owner reads**. Discovering which pokemon shows up when is the
  whole point of the feature, and he is the player.

  So: report counts, not names ("excluded 4 species", not which four). Run
  `sim-encounters.mjs` when a weight changes — its output names species, so quote
  only the summary figures (completion rate, median days, encounters/day). Keep
  `src/pet/encounter.js` and `src/pet/capture.js` species-free so *they* can be
  discussed openly.

  The owner has explained this several times. Do not make him do it again.

More detail on everything above, plus per-machine setup that git does not carry,
is in `docs/handoff.md`.
