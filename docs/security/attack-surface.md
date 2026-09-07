# Security Analysis: `e` orchestrator attack surface

Status: review draft, 2026-09-05. Grounded in the current source
and the ADR set. The goal is a written attack-surface review of the four
execution zones — container, store, local compose stack, and the `serve` BFF —
with concrete, time-boxed recommendations. Implementation of the recommended
fixes is tracked separately (issues with triage labels); this document is the
analysis, not the patch.

## Threat model

The attacker we harden against is a **compromised or prompt-injected harness
agent**: the container runs the harness CLI unsupervised
(`--dangerously-skip-permissions`, see ADR-0002), so anything the agent can
reach, it can abuse. The host is assumed hostile-adjacent for the container:
the container must be treated as untrusted code with full network egress (the
model API must be reachable), limited only by what is mounted and what
credentials are present.

Secondary actors: a **local compromise on the host network** (another process
or container reaching the host's listening ports), and **misconfiguration**
(committed secrets, hardcoded defaults, writable orchestration files).

Non-goals: the model API conversation itself (prompt injection defense lives
with the harness), and the supply chain of the harness image (upstream npm
packages, `npx skills@latest` at build time) — noted, not analyzed here.

## Zone 1: the run container

| Fact                                                                                                                                                                                                                       | Status                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Runs as a **non-root** runtime user (`USER node`, writable home at `/home/node`) in the shared Dockerfile template; the harness registry can override per harness (`runtimeUser`), and every shipped harness runs non-root | **Fixed**                                       |
| No `docker.sock` (or any host socket) is mounted                                                                                                                                                                           | Good                                            |
| Git credentials never enter the container; all git runs host-side (ADR-0002)                                                                                                                                               | Good                                            |
| The run worktree is bind-mounted at `/workspace` read-write                                                                                                                                                                | By design                                       |
| Config overlays (Codex config, skills) are mounted read-only outside `/workspace`                                                                                                                                          | Good                                            |
| Sidecar MCP servers join a private per-run network; the primary joins it only when sidecars exist                                                                                                                          | Good                                            |
| Full network egress (only the model API is _needed_)                                                                                                                                                                       | **Fixed** — egress blacklist monitor (ADR-0011) |
| `.e/.env` injected whole into every container, unfiltered                                                                                                                                                                  | Fixed — whitelisted (see Zone 2)                |

Root in the container was the highest-value finding, now fixed: the harness
Dockerfile template ends with `USER node` (the non-root user `node:lts-alpine`
ships, home `/home/node` — writable, no extra layers) and sets `ENV HOME`
before the skills install so build-time `skills add -g` lands under the same
home the runtime user reads. The runtime-user decision is per-harness, owned by
the harness registry (`runtimeUser`, default non-root); no shipped harness
needs a root override today. All in-container config/skills dirs moved under
`/home/node` (Codex `CODEX_HOME`, pi `PI_CODING_AGENT_DIR`, the shared
`~/.agents/skills`, Claude's `~/.claude/skills`), and derived agent images build
their COPY layers as root then hand the trees back to the runtime user
(`chown` + restore `USER`), so a CLI that writes to its config dir at runtime
still can. Verification caveat for the run worktree bind-mount: `/workspace` is
host-owned, and the container's uid 1000 maps back to the host differently per
engine — rootful Docker maps 1:1 (works when the host user is uid 1000),
rootless Docker/Podman map uid 1000 into the user's subordinate range (the
worktree appears owned by an unmapped uid). Verify writability on the target
deployment: `docker run --rm -v <worktree>:/workspace node:lts-alpine sh -c
'touch /workspace/.e-uid-probe && rm /workspace/.e-uid-probe'`; rootless
engines can bridge the gap with `--userns=keep-id` (Podman) or a matching
`--user`/chown strategy.

Egress monitoring with blacklist enforcement is now live (ADR-0011): every run
starts a shared `<run>-egress` container that runs `dnsmasq` (DNS sinkhole for
blacklisted domains) + `iptables` (REJECT for blacklisted IP:port pairs) with
query logging. The harness agent shares the egress container's network namespace
(`--network container:<run>-egress`), so every socket and DNS query physically
crosses the egress netns where enforcement happens. The agent has NO `NET_ADMIN`
(cannot flush rules or disable the monitor); the egress container gets `NET_ADMIN`
in its own netns only. The blacklist source is host-editable (`.e/egress-blacklist`,
seeded by `e init`), and the operator can reload it mid-run with `docker kill -s HUP`.
Direct-IP connections (bypassing DNS) still hit the iptables REJECT on the OUTPUT
path, so the agent cannot exfiltrate data to a hardcoded IP without crossing the
firewall. Logs are written to a host-visible mount (`/var/log/egress/dnsmasq.log`);
the egress container's stderr shows iptables REJECT events. The blacklist is
"block known-bad destinations" not "allow only known-good" — everything not
blacklisted is reachable, so the agent can reach new APIs without operator
intervention. An allowlist mode (zero-trust WAN) is a future extension.

## Zone 2: Store and secrets

| Fact                                                                                                                                    | Status    |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `.e/.env` (home or `--dir` root) is the sole secret source (ADR-0006); git-ignored                                                      | Good      |
| Secrets are rendered into per-run scratch env-files, disposed after the run                                                             | Good      |
| API keys are never baked into agent images (env-file delivery)                                                                          | Good      |
| Base `.e/.env` container injection is filtered to declared provider/MCP keys (`baseEnvWhitelist`, `filterEnvContent` in `executeSpawn`) | **Fixed** |

The whole-file injection previously meant every secret the user keeps in
`.e/.env` — not just the keys a run's provider and MCP servers declare — was
visible to the untrusted agent. Injection is now filtered to a whitelist built
from `provider.apiKeyEnv`, `provider.baseUrlEnv`, the MCP credential env refs
for the run's selected servers, and the template's global base-URL lines
(`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`). Unknown keys stay in the file (the
user's own shell remains able to read them) but never reach a container.
Harness-specific env templates (pi, Codex-specific sections) are unaffected —
they are a separate, per-harness channel managed by the config adapter. (`#24`.)

## Zone 3: local compose stack (OmniRoute + llama.cpp + Redis)

| Fact                                                                                                                                                                                                                    | Status                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OmniRoute dashboard/API binds **`127.0.0.1:20128`** in `renderCompose.ts` (host-only; untrusted LAN peers cannot reach it); the run container reaches it over shared-network-namespace **localhost**, not the host port | **Fixed**                                                                                                                                                                |
| Default secrets baked into compose: `INITIAL_PASSWORD=local-development`, `JWT_SECRET=local-development-jwt-secret-32-bytes`, `API_KEY_SECRET=local-development-api-key-secret-32-bytes`                                | **Fixed** — fallbacks removed; `e init` seeds random `OMNIROUTE_INITIAL_PASSWORD`/`JWT_SECRET`/`API_KEY_SECRET` into `.e/.env`, preserving values already set on re-init |
| llama.cpp binds `127.0.0.1:9931` host-side                                                                                                                                                                              | Good                                                                                                                                                                     |
| Redis is exposed only on the compose network, with a healthcheck                                                                                                                                                        | Good                                                                                                                                                                     |
| The stack is started by `e spawn` automatically when `.e/compose.yaml` exists                                                                                                                                           | User choice (configurable, see architecture review)                                                                                                                      |

The 0.0.0.0 bind plus hardcoded default credentials was the gap that mattered on
the host network: on an untrusted LAN any machine could open the OmniRoute
dashboard and log in with the well-known default password. Fixed (#25): the
compose stack is split into two networks — `omniroute-stack` (redis, llama.cpp,
bootstrap, OmniRoute's backplane) and `omniroute-edge` (OmniRoute only). The
OmniRoute host port binds to `127.0.0.1` only; `e spawn` attaches the run
container to the edge network when `.e/compose.yaml` exists. The baked agent
base URL (`http://localhost:20128/v1`) reaches OmniRoute directly through the
shared egress network namespace, instead of hopping through a host port that is
unreachable from a Linux/Podman bridge. The run container never joins
`omniroute-stack`, so the untrusted agent
still cannot reach Redis or llama.cpp directly. The compose template no longer
ships fallback secrets, and `e init` seeds fresh random stack secrets into
`.e/.env` (`seedStackSecrets` in `init.ts`). `e spawn` passes `.e/.env` to
`docker compose --env-file` so the ${VAR} interpolation picks the seeded
values; the `spawn.ts` sign-in prompt and unconfigured-key check read
`OMNIROUTE_INITIAL_PASSWORD` from the store env instead of the old literal.
The stack secrets stay out of harness containers: they are not in
`baseEnvWhitelist` (Zone 2), so the injection filter keeps them host-side even
though they now live in `.e/.env`.

llama.cpp already binds localhost correctly and runs as its own service; Redis
is scoped to the compose network. No change needed there.

## Zone 4: `serve` (the BFF per the architecture review)

| Fact                                                                                                                                                        | Status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Express server binds `127.0.0.1` by default                                                                                                                 | Good   |
| Serves the bundled static UI and `/api/health`, `/api/info`                                                                                                 | Good   |
| Detached mode spawns a background `node` process, tracked via `serve.json`                                                                                  | Note   |
| Per the architecture review: becomes a BFF proxying OmniRoute (and runs/status from git refs), key read host-side from `.e/.env`, never sent to the browser | Agreed |

The BFF keeps secrets server-side, so a future read-only browser UI does not
expand the secret exposure. Keep the localhost bind; do not add auth (the UI
is a local observer). One caution for the detached mode: `serve.json` holds a
pid/host/port in `$HOME/.e` and `E_SERVE_DETACHED` gates re-detachment —
verify a stale pid (host reboot) is handled today or add a health check before
reporting "already serving".

## Recommended fixes, in priority order

| #   | Issue                                                | Fix                                                                                                                                                                              | Zone | When                                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [#24](https://github.com/BelphegorPrime/e/issues/24) | Whitelist `.e/.env` injection to declared provider/MCP keys                                                                                                                      | 2    | Done — `baseEnvWhitelist` filter in `planSpawn`/`executeSpawn`, unblocks #2                                                                                                                                                                                                                                             |
| 2   | [#25](https://github.com/BelphegorPrime/e/issues/25) | Bind OmniRoute to `127.0.0.1:20128` with no default secrets; `e init` generates stack secrets; the run container reaches OmniRoute over the compose edge network (service alias) | 3    | Done — two-network compose in `renderCompose.ts`; port bound to `127.0.0.1`; fallbacks removed; `seedStackSecrets` in `init.ts`; `spawn.ts` reads `OMNIROUTE_INITIAL_PASSWORD` from the store env; compose invoked with `--env-file .e/.env`; `executeSpawn` attaches the run to `omniroute-edge` when the stack exists |
| 3   | [#26](https://github.com/BelphegorPrime/e/issues/26) | Non-root runtime user in the harness Dockerfile template, per-harness override                                                                                                   | 1    | `ready-for-agent`                                                                                                                                                                                                                                                                                                       |
| 4   | [#27](https://github.com/BelphegorPrime/e/issues/27) | Egress hardening (proxy/network policy allowing provider + MCP endpoints only)                                                                                                   | 1    | `ready-for-agent`                                                                                                                                                                                                                                                                                                       |
| 5   | [#28](https://github.com/BelphegorPrime/e/issues/28) | Verify stale `serve.json` handling in detached mode                                                                                                                              | 4    | `ready-for-agent`                                                                                                                                                                                                                                                                                                       |

## References

- ADR-0002 (host orchestrates git; accepted egress + whole-file env injection)
- ADR-0005 (container groups, sidecars, private networks)
- ADR-0006 (per-harness config adapter; `.e/.env` as the secret source)
- `src/renderCompose.ts`, `renderBootstrap.ts`,
  `harness/renderDockerfile.ts`, `store.ts`, `serve.ts`
- Issues: [#24](https://github.com/BelphegorPrime/e/issues/24) (env whitelist),
  [#25](https://github.com/BelphegorPrime/e/issues/25) (OmniRoute bind + secrets, done),
  [#26](https://github.com/BelphegorPrime/e/issues/26) (non-root container),
  [#27](https://github.com/BelphegorPrime/e/issues/27) (egress),
  [#28](https://github.com/BelphegorPrime/e/issues/28) (stale serve.json)
