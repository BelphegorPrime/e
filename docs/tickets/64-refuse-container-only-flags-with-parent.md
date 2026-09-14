# 64 - Refuse container-only flags with --parent

**Status:** Open, ready-for-agent.
**GitHub:** Pending - will mirror the created issue.

`e spawn --parent <branch>` runs no container - it writes one sibling
request into the parent run's broker spool and exits. Today, container-only
flags (`--port`, `--no-rm`, `--runtime`, `--rebuild`, `-e/--env`,
`--name`, `--skill`, `--mcp`, `--keep-worktree`) are silently accepted and
ignored, so a user can ask for a container that never starts and nothing
says why. This ticket makes the command fail fast: when `--parent` is set,
any container-only flag is a hard error naming the flag(s), before anything
is written.

**Blocked by:** None - can start immediately.

- [ ] `--parent` with any container-only flag exits non-zero with a message naming the conflicting flags.
- [ ] `--parent` alone (with target and prompt) still writes the request and prints the accepted JSON exactly as today.
- [ ] Tests cover at least one representative flag and the clean `--parent` path.
- [ ] The error message tells the user that a manual child spawns no container.
