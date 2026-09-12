# 02 - runtime-broker sidecar image and spawn-brother skill

**Shipped 2026-09-12.** Design refinement over ADR-0013 (recorded there as an
amendment): the broker owns **no** docker socket. It is an HTTP front for the
run's **spool**, a host-owned directory (`<worktreesDir>/.broker/<runName>`)
bind-mounted at `/var/lib/e-broker`: `POST /spawn {agent, prompt}` validates
and writes `requests/sib-NNN.json`, answering `202 {id, status: "requested",
statusPath}`; `GET /status` merges `run.json` (written by the host before the
broker starts) with every request and the host's `status/<id>.json`;
`GET /status/<id>` serves one. The host `e` process stays the only party with
a runtime and git; consuming the spool (assigning a branch, depth and cap,
checkpoint, merge-back) is tickets 03-07.

Where things live: `src/broker/` (constants, spool, API, server entry, the
skill and its script; the server and the script are type-checked TS bundled by
`scripts/build-broker.mjs` into `bundle.generated.ts`), `src/init/renderBroker.ts`
(the `.e/broker/` build context: `node:24-alpine`, `USER node`, `EXPOSE 20130`,
no volume, no socket; seeded by `e init` and on demand by the first spawn that
needs it), `src/runs/runBroker.ts` (spool dir, `SidecarSpec` with the bind
mount, container `<runName>-broker`, alias `runtime-broker`), `planSpawn`
(`SpawnPlan.broker` is set exactly when the run carries the `spawn-brother`
skill, baked or `--skill`), `runSpawn` (starts it first among the sidecars,
same netns/network rules as MCP sidecars, TCP readiness, spool removed at
teardown unless `--keep-worktree`). The skill ships `SKILL.md` and
`spawn-brother.mjs` (run with the harness image's `node`; exit 3 when the
broker does not answer, with the handoff-file fallback spelled out).

Decisions worth knowing: the image runs as **root** on purpose (like the
egress gateway): it is trusted and secret-free, and it must write a host-owned
bind mount, which root does under every engine while a fixed uid only matches
some hosts. A `child` run plans **no** broker (children inherit the parent's
over the parent's network, ADR-0013). After readiness `runSpawn` checks every
sidecar is still running: in the shared `e-egress` namespace two broker runs
would both bind 20130, the loser dies of EADDRINUSE while the probe hits the
winner, and without the check the agent would spool into the other run. So
under the local stack only one broker run at a time works; a per-run port
would need the host side of ticket 06. The `spawn-brother` skill (like every
shipped skill) is seeded on demand by the first spawn that asks for it, so a
store initialized before this ticket needs no re-init. The `202` answers with
the sibling request id (`sib-NNN`); the sibling's branch arrives in its status
once the host assigns it (06).

**What to build:** A `runtime-broker` sidecar image exposing `POST /spawn` and `GET /status` over the run's private network (no docker socket, no host git credentials). A `spawn-brother` skill (Store `skills/`) teaches an agent inside a container to call the broker over HTTP.

**Blocked by:** None - can start immediately.

**Status:** done

- [x] Broker image runs in a sidecar slot, attached to run network (`SidecarSpec` entry)
- [x] Broker answers `POST /spawn {agent, prompt}` with run identity; `GET /status` reports state
- [x] No docker socket mounted into broker or any agent container (ADR-0002 line held)
- [x] `spawn-brother` skill present in Store `skills/` and mountable via `e spawn ... --skill spawn-brother`
