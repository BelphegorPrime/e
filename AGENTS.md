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

### Spawning siblings from inside a run (planned, not yet implemented)

**Not available today.** `e spawn-brother`, `$E_ROLE` and `$E_BROKER_URL`
are the design of ADR-0013 (status: Proposed; tickets `docs/tickets/01-08`
are open) and do not exist in the CLI yet. Until they ship, delegation from
inside a run means writing the follow-up task down in `/workspace` and
exiting 0 (see `docs/agents/e.md`, Recursive spawning). The intended shape,
for when it lands:

```bash
# Via the spawn-brother skill (post to the runtime-broker sidecar over
the run's private network - no docker socket inside this container):
e spawn-brother "<task description for the brother agent>"
```

- Spawn is **non-blocking**; multiple siblings run in parallel
  (default cap 3, host-enforced).
- Children may request siblings; siblings may never spawn children
  (depth 2).
- Children start from the host's checkpoint commit of your current
  worktree - build artifacts (`node_modules`) are synchronized as needed.
- On completion, the host merges your worktree with your brother's
  branch automatically. If a conflict is detected, merge conflict
  markers appear in your worktree; resolve, then signal the host to
  finalize.
- Your role is set via env vars - check `$E_ROLE` (`parent` | `child`) and
  `$E_BROKER_URL`. Do not create or depend on `child` / `parent`
  marker files in the worktree; role is not a filesystem concept here.

### Common things

- if you want to execute commands be aware that `&amp;` should be replaced with `&`
- longdashes should never be used

### Tests follow code

Any code change (new feature, fix, refactor) must include corresponding test adjustments: add tests for the behaviour you add or change, update or remove tests for deleted code, and ensure `npm run test:coverage` passes. Tests live next to the code as `*.test.ts` (node:test); small modules may be covered through their consumer's test file (for example `renderCompose` through `init.test.ts`) instead of a sibling file. Never ship a behaviour change without a test that would have caught it.
