# 45 - Collect the Run-lifecycle seams: delete the hypothetical ones, keep the Run orchestration as one deep module

**Status:** Done (closed 2026-09-10).

**GitHub:** [#100](https://github.com/BelphegorPrime/e/issues/100)

---

Files src/runs/runBranchNamer.ts · runWorktree.ts · runNetworks.ts · runSidecarOrchestrator.ts · runContainerExecution.ts · runPrManager.ts · runLogCapture.ts · runSpawn.ts

Problem
Seven seams, each with exactly one production adapter plus a dead InMemory* fake in the same file; ResourceCleanupManager duplicates RunScratch with zero callers and zero tests, and uses require() inside an ESM module; ProductionLogCapture.captureEgressLogs is an empty stub that the Run orchestration actually calls — run egress logs are silently never captured.

Solution
Delete the seams nothing varies behind (deletion test: complexity vanishes, does not scatter), delete the unused InMemory* fakes, and either implement egress log capture behind the ContainerRunner seam or cut the call. Keep the Run orchestration — small interface, big behaviour, 769-line test — as the single deep module.

Wins
Cut ~7 hypothetical seams
Surface silent egress-log bug
Remove ESM require()
One adapter = hypothetical seam (drop)
Run lifecycle readable in 1 file

The fanout and splitting runSpawn into multiple files was already a architectual change. But there are still bugs and things to clean up. So analyse that and check what has to improve.
