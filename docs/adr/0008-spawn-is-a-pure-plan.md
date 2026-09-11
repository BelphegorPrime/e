# Spawn is a pure plan plus a thin executor

**Status:** Accepted

`e spawn` is structured as a pipeline: **gather → validate → resolve model →
plan → execute**. Everything that _decides what a run is_ is pure and testable;
the only effects live in a thin edge and a single executor. This records the
split so a future review does not re-merge the decision logic back into the
command action (it had grown to ~400 lines of untested wiring before this).

## The pipeline

1. **`gatherSpawnFacts`** (edge, I/O) reads everything the decisions need (the
   resolved Agent and Harness, the parsed `.e/.env`, every requested MCP server
   and Skill, existence checked on disk) into a pure `SpawnFacts` value.
2. **`validateSpawn(facts)`** (pure, fail-fast) rejects the cheap-to-detect
   errors before anything expensive: a provider protocol the harness does not
   speak, a provider on a harness with no adapter, `--mcp` on a harness with no
   MCP client, skills on a harness that supports none.
3. _(Removed by ADR-0007/ADR-0009.)_ `e` no longer resolves `auto` against
   `/v1/models`; the harness receives `auto` and resolves it at run start. The
   pipeline is gather, validate, plan, execute.
4. **`planSpawn(facts)`** (pure) composes the whole `SpawnPlan`
   as **data**: provider delivery, MCP sidecars vs. remote vs. flag vs. file,
   the config overlay, the derived-image plan, skill mounts, and every
   credential env-file's _content_ (resolving secrets by name and throwing on a
   missing one happens here: pure and testable).
5. **`executeSpawn(facts, plan, deps)`** performs the effects the plan names:
   preflight guards (a git repo, foreground), build the images, materialize each
   rendered file into `RunScratch` and wire the resulting paths, then hand the
   run's lifecycle to `runSpawn`.

## Consequences

- **The interface is the test surface.** `validateSpawn` and `planSpawn` are
  ordinary pure functions over `SpawnFacts`; the composition that used to hide
  in the action closure (the fail-fast order, the per-harness branching, the
  credential rendering) is now asserted directly, without a container, a
  runtime, or the network.
- **Builds move up; `runSpawn` shrinks.** Image building lives in
  `executeSpawn`, before any worktree, preserving the ADR-0005 "build before
  worktree" invariant by construction. `runSpawn` no longer takes
  `ensureImage`/`ensureSidecarImages` closures or owns the `isRepo` guard; it
  receives a built `imageTag` and owns only the run lifecycle
  (worktree, run, commit, push, teardown). The build-effect closures that used
  to be defined in the action and invoked _inside_ `runSpawn` (a
  control-inversion across the seam) are gone.
- **One owner for throwaway secrets.** `RunScratch` owns every rendered
  credential env-file, the config overlay, and the build context; one
  `dispose()` replaces the two hand-threaded cleanup registries, so no
  fail-fast path can leak a mode-0600 secret by forgetting to clean up.
- **One error path.** The action is a single `try/catch` that disposes and
  exits; the ~9 scattered `try { ... } catch { console.error; process.exit(1) }`
  blocks are gone.

## Note on ordering (historical)

When step 3 still existed, credential rendering (and its "missing secret"
error) moved into `planSpawn`, which ran _after_ the model fetch. With the
fetch gone (ADR-0007/0009) the question is moot: every planning error surfaces
before any network call, build or worktree.
