# Tutorial 6: let an agent fan out into sibling runs

Goal: start one run that delegates parts of its task to parallel **sibling**
runs, watch them from the host, and read what came back.

Prerequisite: one working Agent ([Tutorial 1](./01-first-run.md)). The design
is [ADR-0013](../adr/0013-nested-spawn-via-runtime-broker.md); the agent-side
guide is [docs/agents/e.md](../agents/e.md).

## How it works

A run that carries the `spawn-brother` Skill gets a **runtime-broker** Sidecar.
Inside the container the agent runs the Skill's script to post a sibling
request; the host (your `e spawn` process) picks it up, checkpoints the
parent's worktree, starts a new `e spawn` from that checkpoint, and when the
sibling exits merges its branch back into the parent's worktree as a merge
commit. The agent inside never touches git and never sees an engine socket.

Limits, all host-enforced:

- Default cap of 3 siblings in flight per run (`maxSiblings` in
  `~/.e/config.json`); a fourth request is refused with `429` until one
  finishes.
- Depth two: a sibling's requests become siblings of the same parent, nobody
  gets grandchildren.
- `node_modules` from the parent worktree is copied into each sibling
  (`siblingArtifacts` in `config.json`); `.env` and `.git` never are.

## Step 1: start a run that may fan out

```bash
cd /path/to/repo
e spawn --skill spawn-brother pi-anthropic \
  "Split the migration of src/api/ to the new validation library by module. Delegate each module to a brother with a precise task, then integrate their results and make the test suite pass."
```

Or bake the Skill into the Agent (`"skills": ["web-search", "spawn-brother"]`)
so every run of it can delegate.

## Step 2: watch from the host

The parent's log shows each sibling's lifecycle:

```text
Sibling sib-001: starting pi-anthropic for e/pi-anthropic/<slug>-1
Sibling sib-002: starting pi-anthropic for e/pi-anthropic/<slug>-1
Sibling sib-001: merge-back merged
Sibling sib-002: merge-back conflict (src/api/index.ts)
```

and one summary line per sibling at the end: `merged`, `up-to-date`,
`conflict`, or `held`. With `e serve` running, the Runs page shows the same
records live, and `GET /api/runs/<branch>/siblings` returns them as JSON
([Tutorial 7](./07-serve-and-a2a.md)).

## Step 3: read what came back

Everything reaches you through the parent's branch:

```bash
git log --oneline --merges HEAD..e/pi-anthropic/<slug>-1     # one merge commit per sibling
git show e/pi-anthropic/<slug>-1:e-runs/sib-001/report.md    # what the host did with sib-001's branch
git branch --list 'e/*'                                       # sibling branches stay for inspection
```

`e-runs/<id>/report.md` states the sibling's exit code, its branch, the merge
outcome, and what the parent had to do (nothing for `merged`; resolve markers
for `conflict`).

## What the agent does inside

The Skill's `SKILL.md` teaches the harness this loop; you rarely need it, but
it explains the log lines:

```bash
S=~/.agents/skills/spawn-brother/spawn-brother.mjs     # ~/.claude/skills/... under Claude Code
node $S pi-anthropic "Migrate src/api/users.ts to the new validation library; keep its tests green. Touch nothing else."
node $S --status                 # every sibling: requested -> starting -> running -> done | failed | canceled | rejected
node $S --watch                  # block until one needs attention (A2A taskState input-required, completed, failed)
cat e-runs/sib-001/report.md     # the host's report after the merge-back
node $S --merge sib-001          # after editing conflict markers, or finishing 'held' files
node $S --cancel sib-002         # stop a sibling you no longer need
```

`merge.status: conflict` means the host left conflict markers in the named
files; the agent edits them (never runs git) and signals `--merge`. `held`
means the parent was mid-edit in those files; the host retries once more when
the parent exits 0. Every record also carries `taskState`, the
[A2A](https://a2a-protocol.org) lifecycle vocabulary
(`submitted`, `working`, `input-required`, `completed`, `canceled`, `failed`,
`rejected`).

## Tune it

```bash
# ~/.e/config.json
{
  "maxSiblings": 5,
  "siblingArtifacts": ["node_modules", ".venv"]
}
```

An empty `siblingArtifacts` list disables the copy. Both values are read at
spawn time; no rebuild needed.

## A sibling that is a remote agent

A Store Agent with `"transport": "a2a"` can be requested like any other;
the host asks it over the Agent2Agent protocol instead of starting a
container. It has no branch: its answer is the `answer` field of its status
and the `## Answer` section of its report. [Tutorial 7](./07-serve-and-a2a.md)
shows how to define one.
