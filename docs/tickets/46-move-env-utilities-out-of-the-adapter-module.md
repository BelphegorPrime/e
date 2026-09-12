# 46 - Move env utilities out of the adapter module

**Status:** Done (closed 2026-09-10).

**GitHub:** [#101](https://github.com/BelphegorPrime/e/issues/101)

---

Files src/harness/adapter.ts · src/spawn/spawn.ts · src/spawn/executeSpawn.ts · src/init/initPlan.ts

Problem
General dotenv parsing/serialization (parseDotenv, filterEnvContent) lives inside the per-harness config adapter module, but is imported by the spawn edge (store env loading), init planning, and the executor — none of them adapter concerns. The adapter's interface surface grows past its seam, and "where does env parsing live" sends navigators into harness translation code.

Solution
Extract to src/utils/dotenv.ts (next to the other utils). Adapter keeps only harness translation; spawn/init/executor import the shared utility directly.

Wins
Adapter surface shrinks
Locality for en-utils
Zero behaviour change
Cheap, low-risk
