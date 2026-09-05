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

Multi-context layout: a root `CONTEXT-MAP.md` points to a per-package `CONTEXT.md`. See `docs/agents/domain.md`.

### e runs

When running inside `/workspace` from `e spawn`, Git is host-orchestrated:

- `/workspace` is a disposable Git worktree.
- Do not run `git add`, `git commit`, `git push`, or `git worktree`.
- Git metadata and credentials intentionally remain outside the container.
- Make requested file changes only. `e` captures, commits, and pushes them after the harness exits.

### Common things

- if you want to execute commands be aware that `&amp;` should be replaced with `&`
- longdashes should never be used
