# 52 - One in-memory Git adapter instead of five hand-written fakes

**Status:** Open, ready-for-agent.

**GitHub:** [#117](https://github.com/BelphegorPrime/e/issues/117)

---

**Found 2026-09-13 in an architecture review.** The `Git` port has 15 methods, one real adapter (`HostGit`, 285 lines) and **five** hand-written test doubles totalling 354 lines, each re-stubbing all 15 methods:

| Adapter       | Location                   | Lines |
| ------------- | -------------------------- | ----- |
| `FakeGit`     | `runSpawn.test.ts:45`      | 130   |
| `ScriptedGit` | `runSiblings.test.ts:115`  | 67    |
| `FakeGit`     | `serve.test.ts:380`        | 56    |
| `ScriptedGit` | `runMergeBack.test.ts:195` | 55    |
| `StubGit`     | `executeSpawn.test.ts:32`  | 46    |

Plus a sixth, `} as unknown as Git` at `serve.test.ts:1268`, and a seventh added by `nextRunName.test.ts` (6c100cd) for the same reason. They drift: each teaches the Checkpoint and Merge-back contract its own way.

`Git.branchExists` (`ports/git/index.ts:43`) has **zero** production callers - it exists so six adapters must implement it and `host.test.ts` can test it.

**What to build:** `src/ports/git/memory.ts` - an `InMemoryGit implements Git` that holds branches, tips and dirtiness as real data and behaves like git (`commitAll` moves the tip, `addWorktree` creates the branch and throws "already exists" on a collision). Failure cases come from a small `fail` option rather than a new class; `merge` outcomes stay scriptable per branch. Scenarios become setup, not subclasses.

Drop `branchExists` from the interface while you are there.

**Blocked by:** None. Can land incrementally - convert one test file at a time.

- [ ] `InMemoryGit` lives beside `HostGit` and implements the port with real branch/tip state
- [ ] All five fakes plus the `as unknown as Git` cast and `nextRunName.test.ts`'s stub are gone
- [ ] `Git.branchExists` removed from the interface, `HostGit` and its test
- [ ] Every converted test asserts the same behaviour it asserted before
- [ ] `rm -rf dist && npm test` green
