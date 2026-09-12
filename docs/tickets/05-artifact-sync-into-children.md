# 05 - Artifact sync into children

**Shipped 2026-09-12.** `src/runs/runArtifacts.ts`: `planArtifactSync` (pure
allowlist filter), `syncArtifacts` (copy + mounts), `copyArtifact` (the
default copier), `artifactsDirFor`, `removeArtifacts`. `runSpawn` with a
`parent` runs the sync right after the sibling's worktree exists and before
its container starts: each allowed entry present in the parent worktree is
copied to `<worktreesDir>/.artifacts/<runName>/<entry>` and bind-mounted at
`/workspace/<entry>` in the sibling's container - a scratch copy beside the
worktree, never inside it, so it can never land in the sibling's branch
whatever the repo ignores (the ADR's "bind-mount at same path"). Removed at
teardown unless `--keep-worktree`.

The copy is Node's `fs.cpSync` with `COPYFILE_FICLONE`: a reflink where the
filesystem supports it (same filesystem, btrfs / xfs / APFS), a plain copy
otherwise, decided per file - the portable form of `cp --reflink=auto`.
Symlinks are kept verbatim (`verbatimSymlinks`), so the relative links in
`node_modules/.bin` still resolve in the container. `.git`, `.env` and
`.env.*` are never copied: not as an allowlist entry at any depth, not inside
a copied tree (ADR-0002). The allowlist is `siblingArtifacts` in
`.e/config.json` (default `["node_modules"]`; `[]` disables the sync; edited
by hand, a re-init carries it over). `runSpawn` takes it as
`parent.artifacts`; the host side of ticket 06 passes
`readConfig(root).siblingArtifacts`. Verified end to end in
`runSpawn.checkpoint.test.ts` (real git; mounts, symlink, `.env` absent) and
unit-tested in `runArtifacts.test.ts`.

Also decided: only **real paths** inside the parent worktree are synced. The
worktree is written by an unsupervised agent, and a symlinked entry (or a
symlink on the way to one) would hand the sibling any host directory through
the bind mount; such entries are refused with a warning. A copy that fails
(disk full, permissions) is removed and reported with a warning instead of
failing the run - the ADR calls the step optional and the sibling can
regenerate. The never-list is exactly `.git`, `.env`, `.env.*`; other
dotfiles (`.npmrc`, `.envrc`) travel if listed. Known costs: the copy is
synchronous (`fs.cpSync`), so a large `node_modules` on a filesystem without
reflinks blocks the host process for the duration; at run time the engine
creates an empty mountpoint dir in the sibling's worktree, which git ignores.
"Per repo" holds for a repo with its own `.e`; with the home fallback the
allowlist is global, like every other config key.

**What to build:** Host-side copy of an allowlist of build artifacts (default `node_modules`) from parent worktree → child scratch dir, before the child container starts. Uses reflink copy when on same filesystem (`cp --reflink`), plain copy otherwise. Skips `.env` and `.git` always (ADR-0002). Allowlist configurable per repo.

**Blocked by:** None - can start immediately.

**Status:** done

- [x] Snapshot step runs after child worktree created, before child container starts
- [x] `node_modules` (default allowlist) present in child container environment
- [x] `.env` and `.git` never copied, regardless of config
- [x] Reflink copy used on same filesystem; plain copy fallback otherwise
- [x] Config switch to add/remove allowlist entries per repo
- [x] Unit test covers copy + skip rules
