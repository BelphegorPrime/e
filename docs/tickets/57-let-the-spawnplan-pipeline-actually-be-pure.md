# 57 - Let the SpawnPlan pipeline actually be pure

**Status:** Open, ready-for-agent.

**GitHub:** [#122](https://github.com/BelphegorPrime/e/issues/122)

---

**Found 2026-09-13 in an architecture review.** ADR-0008 says spawn is a pure plan and `spawnPlan.ts:147-151` documents `gatherSpawnFacts` as the single I/O step. The code does neither:

- `cli/spawn.ts:398` writes `facts.localStackPresent` and `:444` writes `facts.storeEnv[provider.apiKeyEnv]`, both **after** `validateSpawn` has run. `localStackPresent` is declared optional (`spawnPlan.ts:170`) only so that late write type-checks.
- `spawnPlan.ts:39` imports `SidecarPlan` from `runs/runSpawn.js`, and the file also imports `runs/runBroker.js` and `runs/runRole.js` - the pure planner depends on the orchestrator it sits above.
- `egressBlacklistFile` is declared at `spawnPlan.ts:198`, set at `cli/spawn.ts:271` and read by nobody.
- `worktreesDir` is defaulted twice: `cli/spawn.ts:270` calls `defaultWorktreesDir()`, threads it through, and `runSpawn.ts:243` applies `?? defaultWorktreesDir()` again.

The local-stack and API-key handshake is 50 lines of policy living in an anonymous action closure (`cli/spawn.ts:396-445`), and `spawn.test.ts:300-311` replaces that whole action with a recorder - so those lines have **no coverage at all**.

**What to build:** move the handshake into `gatherSpawnFacts`, which is already the I/O step. `SpawnFacts` becomes readonly and the two optional fields become required. Delete `egressBlacklistFile` and the double default. Put `SidecarPlan`/`BrokerPlan` in their own module so `engine/spawn` stops importing `engine/runs`.

**ADR:** amend ADR-0008 - the amendment records what the code should do, which is what the ADR already said; the point is that nothing enforced it.

**Blocked by:** None.

- [ ] `SpawnFacts` is readonly; nothing mutates it after `gatherSpawnFacts`
- [ ] `localStackPresent` and the resolved provider key are required fields, produced by the gather step
- [ ] The local-stack / API-key handshake has tests
- [ ] `engine/spawn` does not import `engine/runs`
- [ ] `egressBlacklistFile` and the duplicate `worktreesDir` default are gone
- [ ] ADR-0008 amended
- [ ] `rm -rf dist && npm test` green
