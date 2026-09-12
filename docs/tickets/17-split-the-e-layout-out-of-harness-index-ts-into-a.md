# 17 - Split the .e layout out of harness/index.ts into a store module

**Status:** Done (closed 2026-08-08).

**GitHub:** [#6](https://github.com/BelphegorPrime/e/issues/6)

---

## What to build

`harness/index.ts` currently holds two concepts: the **Harness** registry (what CONTEXT.md says it owns) and the on-disk layout of the `.e` directory — path derivation plus the root-finding walk. The layout concept has no name and no home, and its one piece of real branching logic (`findHarnessRoot`) is untested. Extract the layout into a new `store` module.

Introduces a new domain term, **Store**: the `.e` directory holding e's state (harness Dockerfiles and the shared `.env`), located by walking up from the working directory (or `--dir`), falling back to home.

- New `src/store.ts`:
  - Path helpers keyed on the harness **name** (not the `Harness` object): `eBaseDir`, `harnessesBaseDir`, `envFilePath`, `harnessDir(name)`, `dockerfilePath(name)`, `isInitialized(name)`. This keeps the seam one-directional (`harness → store`; `store` never imports `Harness`).
  - Pure `resolveRoot({ explicitDir, cwd, homedir, hasStore })` with a thin `findRoot(explicitDir)` glue that wires real `process.cwd()`, `os.homedir()`, and a `statSync`-based `hasStore` predicate. `findRoot` replaces `findHarnessRoot`.
- `harness/index.ts` keeps `Harness`, `HARNESSES`, `resolveHarness`, and `envHarnessSections` (registry knowledge).
- Call sites in `spawn.ts` and `init.ts` updated to import from `store` and pass `harness.name`.
- `packages/cli/CONTEXT.md` gains the **Store** entry (lands with this commit, since this is the change that introduces the concept).

## Acceptance criteria

- [ ] `src/store.ts` owns all `.e` path derivation + `resolveRoot`/`findRoot`; `store` does not import the `Harness` type.
- [ ] `src/store.test.ts` table-tests `resolveRoot` with a fake `hasStore` predicate and synthetic paths (no temp dirs, no `process.chdir`): explicitDir wins → walk-up finds `.e` → fallback to home → none returns `undefined`.
- [ ] `harness/index.ts` retains only registry concerns; `envHarnessSections` stays there.
- [ ] `packages/cli/CONTEXT.md` defines **Store** (with an `Avoid:` note that "workspace" means npm workspace here).
- [ ] `e init` and `e spawn` root resolution behavior is unchanged; `npm test` passes.

## Blocked by

- #5
