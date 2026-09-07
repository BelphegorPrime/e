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

### e and pi: delegating with `e spawn`

`pi` is the underlying agent harness; `e` is the orchestration layer around it.
`e spawn <agent-or-harness> "<prompt>"` delegates work to a spawned agent, and a
spawned agent can itself use `e spawn` to delegate further, subject to the
sandbox limits of its run. The full model: what a spawned agent receives, how
results return to the parent, and delegation patterns, documented in
`docs/agents/e.md`.

### Common things

- if you want to execute commands be aware that `&amp;` should be replaced with `&`
- longdashes should never be used

### Tests follow code

Any code change (new feature, fix, refactor) must include corresponding test adjustments: add tests for new functions/branches, update or remove tests for deleted code, and ensure `npm run test:coverage` passes. Never ship a code change without touching the relevant test file.
