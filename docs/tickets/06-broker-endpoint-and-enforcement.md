# 06 - Broker HTTP endpoint and depth/cap enforcement

**Shipped 2026-09-12.** The host side of sibling requests is
`src/runs/runSiblings.ts`: a `SiblingConsumer` the parent's `runSpawn` starts
once its broker is ready and stops when the agent's container exits. It polls
the spool, and for every request the broker accepted it writes `starting` and
launches a sibling as a child process of this very CLI: `e spawn <agent>
-- <prompt>` (the ADR-0014 pattern), with the sibling markers in
its environment (`E_SPAWN_ROLE=child`, `E_SPAWN_PARENT_WORKTREE`,
`E_SPAWN_PARENT_BRANCH`, `E_SPAWN_PARENT_NETWORK`, `E_SPAWN_SPOOL`,
`E_SPAWN_SIBLING_ID`; `Env.sibling` / `Env.withSibling`). The sibling process
runs the whole pipeline itself (plan, image, the checkpoint of 04, the
artifact sync of 05), joins the parent's private run network so
`runtime-broker` resolves for it, and reports its own status into the spool:
`running` with its branch (the run identity), then `done` with the exit code
or `failed` with the reason. Stdout/stderr of the sibling process land in the
spool's `logs/<id>.log`.

Depth: every accepted request becomes a sibling under the parent that owns
the broker (a child has no broker and asks through the parent's), so nothing
ever reaches depth 3; a spool whose run is itself a child refuses (`403` from
the broker, `failed` from the consumer). Fan-out: `maxSiblings` in
`.e/config.json` (default 3, carried into `run.json`): the broker answers
`429` while that many requests are in flight (`requested`, `starting` or
`running`), and the consumer picks waiting requests up in arrival order as
slots free. Readiness mirrors the sidecar policy (attempts × poll interval):
a launched sibling that has not reported `running` within `readyAttempts`
polls (default 300 × 1 s) is killed and `failed`. A process that exits
without reporting is `failed` with its exit code; a request still waiting
when the parent's agent exits is `failed` too (nobody is left to receive its
work). `stop()` waits for the siblings in flight before the parent's teardown
takes the network down.

Decided: a sibling neither pushes nor opens a PR; its delivery is the merge
back into the parent (07). The sibling `e spawn` inherits the parent's
`--dir`, `--env-file` and container engine (`E_RUNTIME`), so it uses the same
store, secrets and engine; its own status carries the branch from `starting`
on (right after the branch is cut, before any image build), and a process
that dies without reporting gets the tail of its log in the `failed` reason.
Two safety rules, learned the hard way (a test once fell back to the
production launcher, which re-invokes `process.argv[1]` - under the test
runner the test file itself - and forked without end): a run with a broker
must be given `siblingHost.launch` explicitly, there is no default; and the
production launcher refuses any entry that is not the CLI's `index.js` (or
the single executable). Known limits: a sibling killed for not becoming ready
gets SIGTERM, which disposes its rendered secret files but not its worktree
or branch (`git worktree prune` cleans the former; the branch is harmless);
`stop()` waits for siblings in flight without a bound, as the parent run
itself has none; Ctrl-C on the parent skips every teardown, as it does for
any run today. The broker's `403` and the consumer's depth refusal are
defense in depth: a child gets no broker (`planSpawn`), so in practice they
are unreachable. Until 07 ships, a sibling's work is on its branch
`e/<agent>/<slug>-N` (reported in its status), not in the parent's worktree.

**What to build:** The runtime-broker from #02 wires its HTTP surface: `POST /spawn` accepts a sibling request, assigns a sibling branch, enforces depth ≤ 2 (children may request siblings, never children of children) and concurrency cap ≤ 3 (default, configurable), returns run identity; readiness follows existing `SidecarOrchestrator` policy.

**Blocked by:** None - 02 (broker), 04 (checkpoint) and 05 (artifact sync) shipped 2026-09-12.

**Status:** done

- [x] `POST /spawn {agent, prompt}` creates sibling run; response includes run identity (the request id at once; the branch in `GET /status/<id>` once the sibling reports `running`)
- [x] Requests exceeding depth 2 rejected with error report to caller
- [x] Requests exceeding concurrency cap rejected until a slot frees
- [x] Readiness uses existing `SidecarOrchestrator` probe policy (ADR-0005 mirror)
- [x] Tests cover depth rejection, cap rejection, successful spawn, readiness timeout
