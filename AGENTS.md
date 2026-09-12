# AGENTS.md

Guidance for AI agents working in this repository.

## Agent skills

### Caveman mode

All agent responses must use caveman mode compression. This skill provides ultra-compressed communication that cuts output tokens by 65% while maintaining full technical accuracy. The mode persists until explicitly disabled with "stop caveman" or "normal mode". See `.agents/skills/caveman/README.md`.

### Issue tracker

Issues and PRDs live as GitHub issues in `BelphegorPrime/e`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, each label string equal to its name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: a root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.

### e runs

When running inside `/workspace` from `e spawn`, Git is host-orchestrated:

- `/workspace` is a disposable Git worktree.
- Do not run `git add`, `git commit`, `git push`, or `git worktree`.
- Git metadata and credentials intentionally remain outside the container.
- Make requested file changes only. `e` captures, commits, and pushes them after the harness exits.

### Harness extensions in spawned runs

When asked to add a harness-specific skill, tool, plugin, or other extension
through `e spawn`, do not create a top-level harness-native directory in the
repository or `/workspace` (for example `.pi/`, `.claude/`, `.opencode/`, or
`.codex/`). Those locations are not managed by `e` and must not be used for
e-managed extensions. Use the e-managed Store paths and mechanisms instead;
see `CONTEXT.md` for the extension vocabulary and relevant upstream ecosystems.

### e and pi: delegating with `e spawn`

`pi` is the underlying agent harness; `e` is the orchestration layer around it.
`e spawn <agent-or-harness> "<prompt>"` delegates work to a spawned agent, and a
spawned agent can itself use `e spawn` to delegate further, subject to the
sandbox limits of its run. The full model: what a spawned agent receives, how
results return to the parent, and delegation patterns, documented in
`docs/agents/e.md`.

### Spawning siblings from inside a run

The design is ADR-0013 (tickets `docs/tickets/01-08`, all shipped). A run
that carries the `spawn-brother` skill (`e spawn <agent> --skill
spawn-brother`, or an agent that bakes it) gets the runtime-broker sidecar;
the skill's script posts a sibling request, the host checkpoints your
worktree, starts the sibling from that snapshot with your build artifacts,
reports its status, and when it exits merges its branch back into your
worktree. A sibling has no broker of its own: its requests go through the
parent's broker and become siblings, so nothing ever reaches depth 3.
Requests are refused with `429` while the fan-out cap (default 3) is full;
retry after a sibling finishes. The shape:

```bash
# The spawn-brother skill's script (bundled Node, no curl needed) posts to the
# runtime-broker over the run's network - no docker socket inside this container:
node ~/.agents/skills/spawn-brother/spawn-brother.mjs <agent> "<task description>"
node ~/.agents/skills/spawn-brother/spawn-brother.mjs --status
node ~/.agents/skills/spawn-brother/spawn-brother.mjs --watch [<id>] # block until a sibling needs you
node ~/.agents/skills/spawn-brother/spawn-brother.mjs --merge <id>   # "cleared / resolved, retry the merge"
node ~/.agents/skills/spawn-brother/spawn-brother.mjs --cancel <id>  # stop a sibling you no longer need
```

- Spawn is **non-blocking**; multiple siblings run in parallel
  (default cap 3, host-enforced, `maxSiblings` in `.e/config.json`).
- Children may request siblings; siblings may never spawn children
  (depth 2).
- Children start from the host's checkpoint commit of your current
  worktree - build artifacts (`node_modules`) are synchronized as needed.
- On completion, the host checkpoints your current work and merges the
  sibling's branch into your worktree as a merge commit; its files appear in
  place. The sibling's status then carries `merge` and `report`; read
  `e-runs/<id>/report.md` in your worktree. On `merge.status: conflict`,
  conflict markers are in the files named; resolve them by editing (never
  git), then run `--merge <id>` so the host concludes the merge. On `held`,
  your edits to the named files were in flight; finish them, then signal the
  same way. The host never resolves a conflict for you, and retries held
  merges once more when your run ends with exit code 0.
- Every sibling record carries `taskState`, the Agent2Agent (A2A) lifecycle
  (ADR-0015): `submitted`, `working`, `input-required` (its merge-back is
  `conflict` or `held` and waits for you), `completed`, `failed`, `canceled`,
  `rejected`. Branch on `taskState`; use `--watch` (the broker's
  `GET /status/events`) instead of a poll loop with sleeps.
- A Store agent with `"transport": "a2a"` is a remote A2A agent: request it
  like any other; it has no branch, its answer is the `answer` field of its
  status and the `## Answer` section of its report (`merge.status: skipped`).
- Your role is set via env vars - check `$E_ROLE` (`parent` | `child`) and
  `$E_BROKER_URL` (`http://<host>:<port>`, no trailing slash). Do not create
  or depend on `child` / `parent` marker files in the worktree; role is not a
  filesystem concept here. If the broker does not answer, or a request stays
  `requested`, fall back to writing the follow-up task down in `/workspace`
  and exiting 0 (see `docs/agents/e.md`, Recursive spawning).

### Common things

- if you want to execute commands be aware that `&amp;` should be replaced with `&`
- longdashes should never be used

### Tests follow code

Any code change (new feature, fix, refactor) must include corresponding test adjustments: add tests for the behaviour you add or change, update or remove tests for deleted code, and ensure `npm run test:coverage` passes. Tests live next to the code as `*.test.ts` (node:test); small modules may be covered through their consumer's test file (for example `renderCompose` through `init.test.ts`) instead of a sibling file. Never ship a behaviour change without a test that would have caught it. A change under `ui/` also gets `npm run build:dev && npm run smoke:ui` (headless Chrome against the built UI; see README, Test); fix or explain every finding.
