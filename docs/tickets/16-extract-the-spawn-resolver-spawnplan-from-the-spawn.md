# 16 - Extract the Spawn resolver (spawnPlan) from the spawn command action

**Status:** Done (closed 2026-08-08).

**GitHub:** [#5](https://github.com/BelphegorPrime/e/issues/5)

---

## What to build

The `spawn` command action currently welds testable _decisions_ (env-file precedence, image-build gating) to CLI _effects_ (`process.exit`, `console.error`) inside a Commander `.action()` closure, so those decisions can only be exercised by running the binary. Extract the decisions into a small pure module and thin the action down to glue.

End-to-end behavior of `e spawn` is unchanged; the win is a test surface for the previously-untestable wiring.

- New `src/spawnPlan.ts`:
  - `orderEnvFiles(baseEnvPath: string | undefined, userEnvFile: string | undefined): string[]` — pins the precedence contract (base `.e/.env` first, user `--env-file` overrides it).
  - `decideImageAction({ rebuild, imageExists, initialized }): 'skip' | 'build' | 'not-initialized'` — the image-build gate. String union; the **glue owns** the error message and the build/throw effect.
- `spawn.ts` thinned to glue: computes `initialized = root !== undefined && isInitialized(...)`, preserves the `--rebuild` short-circuit via `const imageExists = !opts.rebuild && runtime.imageExists(tag)`, and acts on the decision. `resolveRuntime`, the `RunOptions` mapping, and the not-a-repo / detached checks (the latter inside `runSpawn`) all stay put.

Pattern: pure-core / thin-glue — no filesystem port introduced (a hypothetical seam, not a real one for a single call site).

## Acceptance criteria

- [ ] `src/spawnPlan.ts` exports `orderEnvFiles` and `decideImageAction` as pure functions (no I/O, no `process`/`console`).
- [ ] `src/spawnPlan.test.ts` table-tests `orderEnvFiles` precedence (base-only, user-only, both-ordered, neither) and `decideImageAction` across the `rebuild`/`imageExists`/`initialized` combinations covering `skip`/`build`/`not-initialized`.
- [ ] `spawn.ts` consumes both functions; the not-initialized error message (with the `--dir` hint) and the `runtime.build` call remain in the action.
- [ ] `--rebuild` still skips the `imageExists` probe (no extra image-inspect call).
- [ ] `e spawn` behavior is unchanged; `npm test` passes.

## Blocked by

- None - can start immediately
