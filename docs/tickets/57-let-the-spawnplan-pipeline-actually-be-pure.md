# 57 - Let the SpawnPlan pipeline actually be pure

**Status:** Done.

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

- [x] `SpawnFacts` is readonly; nothing mutates it after `gatherSpawnFacts`
- [x] `localStackPresent` is a required field, produced by the gather step
- [x] The local-stack / API-key handshake has tests
- [x] The pure planner does not import `engine/runs`
- [x] `egressBlacklistFile` and the duplicate `worktreesDir` default are gone
- [x] ADR-0008 amended
- [x] `rm -rf dist && npm test` green (1011/1011)

---

## What was built, and three corrections to this ticket

**Three claims above were wrong, and the implementation departed from them.**

1. _"Move the handshake into `gatherSpawnFacts`, which is already the I/O step."_
   It cannot go there. The handshake needs the local stack **running** before it
   can ask OmniRoute whether a key is still accepted, so it depends on
   `resolveRuntime` and `composeUp`; putting it in gather would move every
   `validateSpawn` error behind a `compose up` and an interactive API-key
   prompt. A run refused for a reserved `-e` would first start a stack and ask
   the user for a key. It is its own step, **`prepareLocalStack`**, which runs
   _after_ validate and returns a new `SpawnFacts` instead of patching one.

2. _"The resolved provider key is a required field."_ It never was a field - it
   is an entry in `storeEnv`, which the action used to write into in place. With
   `storeEnv` readonly, `prepareLocalStack` returns `{...facts, storeEnv: {...}}`;
   no new field was needed, and there is nothing to make required.

3. _"`engine/spawn` does not import `engine/runs`."_ Too strong:
   `executeSpawn.ts` calls `runSpawn` and must. The real rule, now mechanically
   visible, is that the **pure planner** (`spawnPlan.ts`) imports nothing from
   `runs/` - it has zero such imports.

**Also done, beyond the ticket** (approved in review): the 136-line action body
came out of the anonymous closure. `runSpawnCommand(target, prompt, opts, deps)`
returns an exit code, and what a finished run _says_ is a pure
`spawnReport(result): ReportLine[]`; `process.exit` and the SIGTERM handler are
all that is left in the Commander action. `config.json` is now read once, in
gather (`localRuntimes` and `gitPlatform` ride along in the facts), instead of
three times.

**New modules:** `engine/sidecarPlan.ts` (`SidecarPlan`, `BrokerPlan`,
`defaultBrokerPlan` - the data both halves agree on, below both) and
`engine/runRole.ts` (moved down out of `runs/`). `engine/spawn/prepareLocalStack.ts`
owns the handshake; asking a human for a key stays at the CLI edge as the
caller-supplied `askForKey`.
