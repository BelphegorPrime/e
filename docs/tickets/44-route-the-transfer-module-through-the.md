# 44 - Route the Transfer module through the ContainerRuntime seam

**Status:** Done (closed 2026-09-10).

**GitHub:** [#99](https://github.com/BelphegorPrime/e/issues/99)

---

Files src/transfer/export.ts · src/transfer/import.ts · src/runtime/index.ts

Problem
export.ts and import.ts shell out raw docker volume inspect / docker run / docker volume create via execAsync — a second docker dialect beside ContainerRuntime. All other docker knowledge lives behind the seam; this duplicates it, is untestable without a live daemon, and keeps the seam from being the single place docker argv is built.

Solution
Add volume operations (volumeInspect, volumeExport, volumeImport, or one generic detached run) to ContainerRunner. Transfer becomes thin effect-execution over the plan, testable against a fake runner — same shape ADR-0008 gave spawn.

Wins
One docker dialect total
Transfer logic testable
Seam gains real depth
Bypass route closes
