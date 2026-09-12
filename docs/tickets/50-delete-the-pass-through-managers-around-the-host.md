# 50 - Delete the pass-through managers around the host ports

**Status:** Open, ready-for-agent.

**GitHub:** [#115](https://github.com/BelphegorPrime/e/issues/115)

---

**Found 2026-09-13 in an architecture review.** Five modules under `src/engine/runs/` declare an interface, implement it once, are never injected, have no test double and no co-located test. `runSpawn` constructs them itself (`runSpawn.ts:246-249`). Each re-exports a method the Host port next to it already has, some of them wrapping a synchronous call in `async`. A seam with one adapter is a hypothetical seam.

`BranchNamer` was the sixth; it already collapsed into `nextRunName` (6c100cd).

**What to build:**

- Delete `runNetworks.ts` (25 lines: `createNetwork`/`removeNetwork` are one-line forwards to `ContainerRunner` methods of the same name, plus `export const ProductionNetworkManager = DockerNetworkManager`).
- Delete `runWorktree.ts` (19 lines: `removeWorktree` is `await this.git.removeWorktree(path)` on a `void`-returning sync port method).
- Delete `runPrManager.ts` (44 lines: re-declares `PullRequestSpec`'s five fields twice and copies them across; its only real content is the try/catch turning a throw into `{url: '', warning}`, which belongs at the one call site).
- Keep `isSidecarReady` and `waitForAllReady` from `runSidecarOrchestrator.ts` as free functions; drop the `SidecarOrchestrator` interface and the class - `startAll`/`stopAll` are `for` loops over one runner call each.
- Trim `runBroker.ts`: four of six exports forward constants and spool helpers that `sidecars/broker/contract/*` already owns.
- Trim `runRole.ts`: two of six exports are pure re-exports (`BROKER_URL_ENV`, `ROLE_ENV` from the broker contract; `parseRunRole`, `RunRole` from `shared/runRole.ts`).

**ADR:** reads against the spirit of ADR-0005 (runs as composed container groups). Add a short amendment recording that one implementor is not a seam. A grep for `NetworkManager|WorktreeManager|BranchNamer|PullRequestManager|SidecarOrchestrator` outside their defining files returns zero hits.

**Blocked by:** None.

- [ ] `runNetworks.ts`, `runWorktree.ts`, `runPrManager.ts` deleted; `runSpawn` calls the ports directly
- [ ] `SidecarOrchestrator` interface and class gone; the two readiness functions survive as free functions
- [ ] `runBroker.ts` and `runRole.ts` keep only exports that carry behaviour
- [ ] `waitForAllReady`'s retry loop is reachable from a test without driving a whole `runSpawn`
- [ ] ADR-0005 amended
- [ ] `rm -rf dist && npm test` green, eslint and prettier clean
