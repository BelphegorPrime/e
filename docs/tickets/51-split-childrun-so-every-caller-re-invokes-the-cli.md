# 51 - Split childRun so every caller re-invokes the CLI the same way

**Status:** Open, ready-for-agent.

**GitHub:** [#116](https://github.com/BelphegorPrime/e/issues/116)

---

**Found 2026-09-13 in an architecture review.** Four places re-invoke `e` as a child and each assembles the invocation itself. `childRun.ts` (39d6556) unified the two spool-backed ones, but it is spool-coupled: `startChildRun` needs a `spoolDir` and a `SpawnRequest`, `settleChildRun` writes a status. `serve --detached` (`serve.ts:118-124`) and Terminal sessions (`terminalSessions.ts:104-111`) have no spool, so they still hand-roll theirs.

Two of the four build `e spawn`'s argv from string literals that no type connects to `registerSpawnCommand`'s flag declarations (`spawn.ts:328-360`): rename a flag and nothing fails to compile. `AGENT_NAME` is byte-identical in `terminalSessions.ts:95` and `tasks.ts:91`.

**What to build:** a spool-free layer under `childRun.ts` - `assertCliEntry`, the process spawn, the `ChildHandle`, and a typed argv builder for `e spawn`. `childRun.ts` keeps the spool layer on top. Terminal sessions and `serve --detached` call the lower layer.

The argv builder takes what the command actually accepts (agent, prompt, `--name`, `--skill`, `--mcp`, passthrough) so a flag rename is a type error at every call site.

**Note:** stdio and lifecycle genuinely differ (detached + `stdio: 'ignore'`, headless TTY with pipes, log file) - that stays a parameter, not three copies of the spawn.

**Blocked by:** None (`childRun.ts` exists).

- [ ] A spool-free module owns `assertCliEntry`, the spawn, the handle and the argv builder
- [ ] `childRun.ts` builds on it; its behaviour is unchanged
- [ ] `terminalSessions.ts` and `serve --detached` use it; neither builds argv or re-checks the CLI entry itself
- [ ] `serve --detached` and the browser terminal gain the fork-bomb guard they lack today
- [ ] `AGENT_NAME` lives in one place
- [ ] Renaming an `e spawn` flag breaks the build at every caller (add a test that pins the argv shape)
- [ ] `rm -rf dist && npm test` green
