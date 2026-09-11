# 05 - Artifact sync into children

**What to build:** Host-side copy of an allowlist of build artifacts (default `node_modules`) from parent worktree → child scratch dir, before the child container starts. Uses reflink copy when on same filesystem (`cp --reflink`), plain copy otherwise. Skips `.env` and `.git` always (ADR-0002). Allowlist configurable per repo.

**Blocked by:** None - can start immediately.

**Status:** ready-for-agent

- [ ] Snapshot step runs after child worktree created, before child container starts
- [ ] `node_modules` (default allowlist) present in child container environment
- [ ] `.env` and `.git` never copied, regardless of config
- [ ] Reflink copy used on same filesystem; plain copy fallback otherwise
- [ ] Config switch to add/remove allowlist entries per repo
- [ ] Unit test covers copy + skip rules
