# Lint and Format Agent-Produced Code Before Push

## Summary

Code created by harness agents runs inside a disposable container worktree. Git
lives on the host machine; the container never touches git metadata or
credentials (ADR-0001, ADR-0002). Today `e` commits leftover changes and pushes
the branch without any lint/format gate, so badly formatted agent code can reach
origin.

Goal: every agent-produced commit is linted and formatted against the project's
definitions before it is pushed, for any programming language.

## Background and Constraint

- Runs execute in an isolated per-run git worktree created on the host and
  bind-mounted into the container at `/workspace` (ADR-0001).
- All git operations for a run (worktree, commit, push, cleanup) run in the host
  `e` process; the container has no git (ADR-0002).
- `.git/hooks` is not version-controlled and worktrees are disposable, so hook
  files written from inside a run are lost with the checkout.
- Only tracked files survive a run (ADR-0001). A configuration template committed
  to the repo is therefore the durable artifact.

Consequence: traditional "install a hook during the run" does not work. The
durable mechanism must be `e`-hosted (host tool + tracked config + host-side hook
wiring), not container-authored.

## Approach

Adopt [prek](https://github.com/j178/prek) as the hook runner:

- Single Rust binary, no runtime dependencies, drop-in compatible with
  `pre-commit` configs, polyglot (Python, Node.js, Bun, Go, Rust, Ruby, PHP,
  Deno, mise...), supports monorepo workspaces.
- Config lives in a tracked `prek.toml` or `.pre-commit-config.yaml`. Language
  coverage is data-driven: each hook declares `files:` globs; a new language is
  one new tracked config entry.

### A. `e lint init` subcommand

New `e` subcommand (follow `e init` pattern).

Responsibilities:

1. Ensure `prek` is available on the host `PATH` (install on demand via
   standalone installer; fail loudly).
2. Scaffold a tracked template config at the repo root. Never clobber existing
   configs (`writeIfAbsent` invariant).
3. Wire hooks into host git.

Hook wiring: `e` points `core.hooksPath` at a persistent template directory on
the host. Git hooks installed once; every future worktree and host-side
interactive commit picks them up. The hook fires on git commit in the host
process, so `e` needs no dedicated lint run in its capture path.

### B. Enforcement

The gate is the git hook itself. When `e` (host) commits leftover agent changes,
git runs prek via `core.hooksPath`; the same hook covers interactive host-side
commits.

- Lint failures trigger a **warning but do NOT block** the commit (non-fatal,
  branch preserved).
- Format-on-write hooks fix files before the commit lands.
- Run scope (staged-only vs all files) follows prek defaults.

## Scope

In scope:

- `e lint init` subcommand (prek install + template config scaffold + hook
  wiring).
- Tests for the new commands and the hook installation (`npm run
  test:coverage` must pass).
- Documentation: `docs/agents/linting.md` update describing prek config,
  per-language hook patterns, and CI parity (prek-action or `prek run
  --all-files` in CI).

Out of scope:

- Per-language lint rules themselves; they are user configuration, added to the
  tracked template.
- Changing the git host-orchestration model (ADR-0002 stands).
- A dedicated `prek run` step inside `e`'s capture path (the hook alone is the
  gate).

## Acceptance Criteria

1. `e lint init` installs prek on the host on demand or errors clearly; it does
   not silently proceed without a usable binary.
2. `e lint init` writes a tracked template hook config at the repo root; existing
   hand-edited configs are preserved with a diff, never overwritten.
3. `e lint init` points host `core.hooksPath` at the persistent template
   directory.
4. Agent-produced code that violates the project lint rules produces a warning
   but the commit proceeds and the branch is preserved.
5. Formatting hooks fix staged files; fixes are included in the pushed commit.
6. A new language requires only a new entry in the tracked config (with
   documented template entries for the common languages).
7. CI runs the same checks (e.g. j178/prek-action or `prek run --all-files`) so
   the gate cannot be bypassed via a non-gated path.
8. `npm run test:coverage` passes with coverage for the new subcommand and the
   hook installation.