# 54 - Absorb the runtime argv builders and test ContainerRuntime through its port

**Status:** Open, ready-for-agent.

**GitHub:** [#119](https://github.com/BelphegorPrime/e/issues/119)

---

**Found 2026-09-13 in an architecture review.** `ports/runtime/index.ts` exports 16 pure argv builders (`buildImageArgs`, `sidecarRunArgs`, `tcpProbeArgs`, ...). Every one of them has **zero** callers outside `index.ts` itself and `runtime.test.ts` - the comment at `:141-147` says outright they were extracted so the tests could assert argv.

The result is testability bought at the cost of locality: `runtime.test.ts` is 667 lines asserting argument arrays, while the 607-line file has no co-located test of the class that calls them. The bugs live in the wiring, which nothing covers.

**What to build:** an exec seam on `ContainerRuntime` (the `spawnSync`/`execFileSync` it uses, injectable), the argv builders made module-private, and `runtime.test.ts` rewritten to drive the class through `ContainerRunner` with a recording exec. The same assertions survive - they just run one layer out, where a wrong argv and a wrong call site both fail.

**Blocked by:** the port-widening ticket.

- [ ] `ContainerRuntime` takes its process runner as a dependency
- [ ] No argv builder is exported
- [ ] `runtime.test.ts` exercises the class through the port and still pins every argv it pinned before
- [ ] `ports/runtime/index.ts` has a co-located test covering `run`, `build` and the volume copy paths
- [ ] `rm -rf dist && npm test` green
