# 02 - runtime-broker sidecar image and spawn-brother skill

**What to build:** A `runtime-broker` sidecar image exposing `POST /spawn` and `GET /status` over the run's private network (no docker socket, no host git credentials). A `spawn-brother` skill (Store `skills/`) teaches an agent inside a container to call the broker over HTTP.

**Blocked by:** None - can start immediately.

**Status:** ready-for-agent

- [ ] Broker image runs in a sidecar slot, attached to run network (`SidecarSpec` entry)
- [ ] Broker answers `POST /spawn {agent, prompt}` with run identity; `GET /status` reports state
- [ ] No docker socket mounted into broker or any agent container (ADR-0002 line held)
- [ ] `spawn-brother` skill present in Store `skills/` and mountable via `e spawn ... --skill spawn-brother`
