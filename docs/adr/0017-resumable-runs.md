# ADR-0017: Resumable runs - the session outlives the container

**Status:** Proposed
**Date:** 2026-09-30
**Related:** [ADR-0001 (per-run git worktree)](./0001-per-run-git-worktree.md), [ADR-0002 (host orchestrates git)](./0002-host-orchestrates-git.md), [ADR-0003 (run identity and ledger)](./0003-run-identity-and-ledger.md), [ADR-0006 (per-harness config adapter)](./0006-per-harness-config-adapter.md), [ADR-0013 (nested spawn via runtime-broker)](./0013-nested-spawn-via-runtime-broker.md), [ADR-0015 (A2A vocabulary)](./0015-a2a-vocabulary-facade-and-remote-agents.md), [ADR-0016 (autonomous runs)](./0016-autonomous-runs.md), issue #171

## Context

A finished, canceled or crashed Run cannot be continued. Its **code state**
survives: the branch is the durable artifact (ADR-0001) and teardown keeps a
dirty worktree on disk. Its **conversation state** does not: every harness
keeps its session inside the container (pi under `~/.pi/agent/sessions`), and
the container is `--rm`. Spawning again on the same task gives a fresh agent
on a fresh branch that has to re-read everything - a retry, not a resume.

Comparable orchestrators treat suspend and resume as a first-class operation
for long tasks. `e` has every piece but one: a place for the session to live
that is neither the container nor the branch.

## Decision

### 1. `e resume <run-branch> ["follow-up prompt"]`

A new command. It continues the harness session of an earlier Run **on the
same branch**, in a fresh container, with the same agent, MCP servers and
per-run skills the Run was started with. The prompt is the mode switch, as for
`e spawn`: with one it runs one-shot and hands the follow-up to the resumed
session; without one it opens the harness TUI on the resumed session (and is
refused without a terminal). Commit, push, PR, the verify gate and the caps
are `runSpawn`'s, unchanged.

A resumed Run is a **manual** Run: resume is a human act, so its new commits
carry no provenance trailers (ADR-0016 section 9) even when the original was
triggered - `git log --grep E-Trigger` keeps meaning "machine-started".

### 2. Sessions are persisted per Run, on the host

Every Run of a harness that can resume (section 3) mounts a host directory as
the harness's session directory:

```
.e/runs/sessions/<run name>/
  session.json   # the record: agent, harness + version, provider, base,
                 # mcp, skills, elapsed wall clock, created/updated
  harness/       # bind-mounted at the harness's sessionDir
```

- **Outside the worktree and the branch.** The directory is in the Store, not
  under the worktrees dir, so it is never inside `/workspace` and can never
  ride along in a `commitAll`. `.e/runs/sessions/` carries its own
  `.gitignore` (`*`), so a Store that is partly committed (the Base Store of
  ADR-0016) never commits a transcript either.
- **`sessions/` beside `queue/`, `live/` and `dead/`**, not `.e/runs/<run>/`
  as the issue sketched: `.e/runs/` already holds the queue spools and
  `serve.json`, and one more fixed name keeps a run directory from ever
  meaning something else there.
- **The serving Store's.** A triggered Run keeps it in the checkout's `.e/`,
  never in the Base Store, which is a scratch copy disposed with the Run.
- **Not for a Sibling run.** A sibling's delivery is the merge-back into its
  parent (ADR-0013); resuming it as a Run of its own would push it and open a
  PR the parent never asked for. The parent is what gets resumed.
- **Created 0700, record 0600**, owned by the host user. The container writes
  into it as its runtime user, under the same uid assumption the worktree bind
  mount already makes.

### 3. The harness declares the capability

`Harness` gains two optional members, next to `buildCommand`:

- `sessionDir` - the absolute in-container directory the harness keeps its
  sessions in, outside `/workspace`. For pi it is `~/.pi/agent/sessions`,
  pi's own default for a run in `/workspace` (`getDefaultSessionDirPath`,
  pi 0.99.0), so a plain `pi -p` persists into the mount with no flag.
- `resumeCommand(prompt?, model?)` - the argv that continues the most recent
  session in that directory: pi `--continue`, with `-p <prompt>` one-shot and
  without it for the TUI.

Both present is the `resume` capability in `harnessCapabilities`; `e resume`
on any other harness fails fast, naming the ones that can, the way `--mcp` is
gated for opencode. **pi only** for now. The candidates for the others,
unverified against their pins and therefore not wired: Claude Code
`--resume <id>` / `--continue`, Codex `exec resume --last`, opencode
`--continue`. Each gets its `sessionDir` and `resumeCommand` in its own change,
verified against its pinned version.

### 4. The worktree is the branch's own

`e resume` does not cut a new `-N`. If the Run's worktree is still on disk
(kept dirty, or `--keep-worktree`), it is reused as it is, uncommitted work
included - that is the crashed state to continue from. Otherwise the existing
branch is checked out into a new worktree at the same path
(`Git.checkoutWorktree`: `git worktree add <path> <branch>`, which also takes
a branch that only exists on origin). The PR base is the one the Run recorded.

### 5. The session on cancel

The cancel path (ADR-0015) and the caps (ADR-0016) end the container with a
SIGKILL, and this ADR does not add a SIGTERM grace period: pi appends every
session entry to its JSONL file as it happens, so a killed pi session keeps
everything but the turn in flight, which is also exactly what the worktree
holds. A harness whose session is only written on a clean exit would need the
grace period; verifying that is part of wiring its `resumeCommand`.

## The open decisions of #171

**Secrets in transcripts.** A session holds prompts, model output and tool
output, and tool output can carry env values - the provider key the run was
given, for one. The transcript is stored in the Store with the modes above,
mounted only into later containers of **the same Run** (which had the same
secrets already), never into a sibling, never exported (`e export` does not
include `runs/`), never pushed. Retention is bounded: a session whose record
was last updated more than **14 days** ago is deleted whenever a new session is
prepared in the same Store. Deleting one by hand is removing its directory;
nothing else refers to it. `docs/security/attack-surface.md` Zone 2 records
this.

**Agent drift.** The record names the harness, its version and the provider.
A different **harness** is refused: a session file is the harness's own format.
A different harness **version** or **provider** (endpoint, protocol, model) is
a warning, and the resume goes ahead: pi's session is provider-agnostic, and
refusing would strand the work of every agent whose model was bumped.

**Wall clock.** Carried over. The record accumulates the wall clock of every
non-interactive invocation, and a resumed Run's hard total timer is
`loop.totalTimeoutMs` minus what was already spent; a Run that has spent it
all is refused before anything is built. The attempt count is not carried: the
agent cannot resume itself - `e resume` is a host command and only a human
types it - so the loop's per-invocation `maxIterations` cannot be escaped from
inside, and the ordinal the agent is told stays the attempt of this
invocation. `resources` apply as to every Run.

**Siblings.** Refused while the Run's broker spool still lists a sibling whose
task state is `submitted`, `working` or `input-required` (a merge-back waiting
on the parent), and while the Run's own container is still running. The spool
is normally gone with the Run; it survives only with `--keep-worktree`, which is
exactly when a stale sibling can exist.

**Sidecar state.** MCP sidecars and the runtime-broker are recreated from
scratch: the servers the record names are started again, empty. Anything a
server held in memory is gone. Known limit, documented.

## Consequences

- Every pi Run now leaves a transcript on the host for up to 14 days. That is
  new data at rest, bounded and 0700, and it is the whole feature.
- `Git` gains one method, `checkoutWorktree`.
- `runSpawn` gains a resume mode (existing branch, `resumeCommand`, the carried
  wall clock) and a session mount; a Run of a harness without the capability
  is unchanged.
- The other three harnesses cannot be resumed until each is verified.
- Known limits: resuming a Run whose PR is already open tries to open it
  again, which the platform refuses, so the report carries a PR warning; the
  wall clock is recorded when the invocation ends, so a host process killed
  outright does not add its time; and the preflight checks the budget against
  the Store's `loop.totalTimeoutMs`, not a Trigger's override of it. A worktree
  dir that vanished while git still lists it (a reboot wiped the temp dir) is
  pruned before the branch is checked out again.

## Not in scope

`e attach` / `e exec` (serve already attaches via the engine API) and a live
log view in `e serve` (ADR-0010 excludes it) are separate tickets.
