# 59 - Unify the two A2A remote-call paths and break the spawn/a2a cycle

**Status:** Open, ready-for-agent.

**GitHub:** [#124](https://github.com/BelphegorPrime/e/issues/124)

---

**Found 2026-09-13 in an architecture review.** `remoteSpawn.ts` and `remoteSibling.ts` repeat the same sequence independently: the `wireTaskState` / `taskAnswer` pair, `client.sendMessage(...)`, the `if (sent.kind === 'message')` branch, `waitForTask`, and a `switch (state)` over `completed` / `input-required` / `canceled` / `rejected` / default. `remoteSpawn.ts:59-97` against `remoteSibling.ts:79-131` - same shape, differing only in whether the outcome is `log.*` plus an exit code or a status write plus an exit code.

`remoteSibling.ts:63-68` also re-implements `runSpawn.ts:275-280`'s `report()` closure line for line: same name, same signature, same body.

The packages depend on each other both ways: `engine/spawn/executeSpawn.ts:41` imports `a2a/remoteSibling`, and `a2a/remoteSibling.ts:17` imports from `engine/runs`. The branch that decides "child process or A2A call" lives in `executeSpawn.ts:56-72` - the image-building module - rather than in an a2a module.

**What to build:** one module owning the send-wait-settle sequence against a Remote agent, with the two outcome shapes as its parameter. Move the "process or A2A" decision out of `executeSpawn` so `engine/spawn` stops importing `engine/a2a`.

**Note:** `childRun.ts` (39d6556) already owns the status write for child runs - `remoteSibling`'s hand-rolled `report()` should go through it or through the same rule.

**Blocked by:** None.

- [ ] The send-wait-settle sequence exists once
- [ ] `remoteSibling` does not re-implement `runSpawn`'s status reporting
- [ ] `engine/spawn` does not import `engine/a2a`
- [ ] Both paths keep their current observable behaviour, pinned by tests
- [ ] `rm -rf dist && npm test` green
