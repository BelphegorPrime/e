# 43 - Cut the dead compose/log surface off the ContainerRuntime seam

**Status:** Done (closed 2026-09-10).

**GitHub:** [#98](https://github.com/BelphegorPrime/e/issues/98)

---

Files src/runtime/index.ts](runtime/index.ts) · src/runtime/runtime.test.ts

Problem
The ContainerRunner interface claims capabilities nothing calls: composeUp / composeWait / composeRestart (ADR-0005 deferred the compose engine) and containerLogs have no production caller — only tests. The interface is the test surface; every dead method is a contract to maintain and a test to write for behaviour nobody consumes.

Solution
Trim the interface to what the Run orchestration consumes (run, build, network, sidecar start/probe, exec readiness, inspect). Rather than deleting compose readiness wholesale, move the trio behind a narrow internal helper or a separate module until ADR-0005's compose groups actually need it.

Wins
Smaller test surface
Interface matches callers
One less dialect to keep honest
Preps seam for candidate 3
