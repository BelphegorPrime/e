# Security Analysis: `e` orchestrator attack surface

Status: review draft, 2026-09-05; egress and BFF sections refreshed 2026-09-11
after ADR-0011/0012 shipped. Grounded in the current source
and the ADR set. The goal is a written attack-surface review of the four
execution zones - container, store, local compose stack, and the `serve` BFF -
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
packages, `npx skills@latest` at build time) - noted, not analyzed here.

## Zone 1: the run container

| Fact                                                                                                                                                                                                                       | Status                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Runs as a **non-root** runtime user (`USER node`, writable home at `/home/node`) in the shared Dockerfile template; the harness registry can override per harness (`runtimeUser`), and every shipped harness runs non-root | **Fixed**                                                  |
| No `docker.sock` (or any host socket) is mounted                                                                                                                                                                           | Good                                                       |
| Git credentials never enter the container; all git runs host-side (ADR-0002)                                                                                                                                               | Good                                                       |
| The run worktree is bind-mounted at `/workspace` read-write                                                                                                                                                                | By design                                                  |
| Config overlays (Codex config, skills) are mounted read-only outside `/workspace`                                                                                                                                          | Good                                                       |
| Sidecar MCP servers share the global `e-egress` namespace with the agent when the local stack runs (their traffic is logged and filtered too); without the stack they fall back to a private per-run network               | Good                                                       |
| Full network egress (only the model API is _needed_)                                                                                                                                                                       | **Fixed** with the local stack (ADR-0011); open without it |
| `.e/.env` injected whole into every container, unfiltered                                                                                                                                                                  | Fixed - whitelisted (see Zone 2)                           |

Root in the container was the highest-value finding, now fixed: the harness
Dockerfile template ends with `USER node` (the non-root user `node:lts-alpine`
ships, home `/home/node` - writable, no extra layers) and sets `ENV HOME`
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
engine - rootful Docker maps 1:1 (works when the host user is uid 1000),
rootless Docker/Podman map uid 1000 into the user's subordinate range (the
worktree appears owned by an unmapped uid). Verify writability on the target
deployment: `docker run --rm -v <worktree>:/workspace node:lts-alpine sh -c
'touch /workspace/.e-uid-probe && rm /workspace/.e-uid-probe'`; rootless
engines can bridge the gap with `--userns=keep-id` (Podman) or a matching
`--user`/chown strategy.

Egress monitoring with blacklist enforcement is live (ADR-0011) whenever the
local Compose stack runs: one global `e-egress` container runs `dnsmasq` (DNS
sinkhole for blacklisted domains, query logging) and applies the host's
`iptables` rules script (REJECT for direct IP:port destinations). The harness
agent and its MCP sidecars are started with `--network container:e-egress`, so
every socket and DNS query physically crosses the egress netns where
enforcement happens. Runs without the stack keep unrestricted bridge
networking. The agent has NO `NET_ADMIN` (cannot flush rules or disable the
monitor); the egress container gets `NET_ADMIN` in its own netns only. Both
policy sources are host-editable and seeded by `e init` (`.e/egress-blacklist`,
`.e/egress-iptables.rules`; the rules file ships with comments only, so
direct-IP blocking is opt-in per operator), and the operator can reload them
mid-run with `docker kill -s HUP e-egress`. Direct-IP connections that match a
rule hit the iptables REJECT on the OUTPUT path; a destination with no rule
is not blocked. Logs are written to a host-visible mount (`/var/log/egress/dnsmasq.log`);
the egress container's stderr shows iptables REJECT events. The blacklist is
"block known-bad destinations" not "allow only known-good" - everything not
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
`.e/.env` - not just the keys a run's provider and MCP servers declare - was
visible to the untrusted agent. Injection is now filtered to a whitelist built
from `provider.apiKeyEnv`, `provider.baseUrlEnv`, the MCP credential env refs
for the run's selected servers, and the template's global base-URL lines
(`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`). Unknown keys stay in the file (the
user's own shell remains able to read them) but never reach a container.
Harness-specific env templates (pi, Codex-specific sections) are unaffected -
they are a separate, per-harness channel managed by the config adapter. (`#24`.)

## Zone 3: local compose stack (OmniRoute + llama.cpp + Redis)

| Fact                                                                                                                                                                                                                    | Status                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OmniRoute dashboard/API binds **`127.0.0.1:20128`** in `renderCompose.ts` (host-only; untrusted LAN peers cannot reach it); the run container reaches it over shared-network-namespace **localhost**, not the host port | **Fixed**                                                                                                                                                                |
| Default secrets baked into compose: `INITIAL_PASSWORD=local-development`, `JWT_SECRET=local-development-jwt-secret-32-bytes`, `API_KEY_SECRET=local-development-api-key-secret-32-bytes`                                | **Fixed** - fallbacks removed; `e init` seeds random `OMNIROUTE_INITIAL_PASSWORD`/`JWT_SECRET`/`API_KEY_SECRET` into `.e/.env`, preserving values already set on re-init |
| llama.cpp binds `127.0.0.1:9931` host-side                                                                                                                                                                              | Good                                                                                                                                                                     |
| Redis is exposed only on the compose network, with a healthcheck                                                                                                                                                        | Good                                                                                                                                                                     |
| The stack is started by `e spawn` automatically when `.e/compose.yaml` exists                                                                                                                                           | By design; not configurable yet (ADR-0010)                                                                                                                               |
| The egress API (ADR-0012) listens in the egress netns and is published on `127.0.0.1:20129` for the BFF; it has no auth, so any local process or netns container (the agent included) can add/remove blacklist domains  | Accepted for now; input is validated as DNS names, so the blast radius is blocking or unblocking domains                                                                 |

The 0.0.0.0 bind plus hardcoded default credentials was the gap that mattered on
the host network: on an untrusted LAN any machine could open the OmniRoute
dashboard and log in with the well-known default password. Fixed (#25): the
compose stack has one `e-net` network for the egress container.
OmniRoute, Redis, llama.cpp, and bootstrap share its network namespace. The
OmniRoute host port binds to `127.0.0.1` only; the baked agent base URL
(`http://localhost:20128/v1`) reaches OmniRoute directly through the shared
egress network namespace, instead of hopping through a host port that is
unreachable from a Linux/Podman bridge. The run container joins no Compose
network, so the untrusted agent still cannot reach Redis or llama.cpp directly.
The compose template no longer
ships fallback secrets, and `e init` seeds fresh random stack secrets into
`.e/.env` (`seedStackSecrets` in `src/init/initPlan.ts`). `e spawn` passes `.e/.env` to
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
pid/host/port in `$HOME/.e` and `E_SERVE_DETACHED` gates re-detachment -
verify a stale pid (host reboot) is handled today or add a health check before
reporting "already serving".

## Recommended fixes, in priority order

| #   | Issue                                                | Fix                                                                                                                                                          | Zone | When                                                                                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [#24](https://github.com/BelphegorPrime/e/issues/24) | Whitelist `.e/.env` injection to declared provider/MCP keys                                                                                                  | 2    | Done - `baseEnvWhitelist` filter in `planSpawn`/`executeSpawn`, unblocks #2                                                                                                                                                                                                                   |
| 2   | [#25](https://github.com/BelphegorPrime/e/issues/25) | Bind OmniRoute to `127.0.0.1:20128` with no default secrets; `e init` generates stack secrets; the run reaches OmniRoute through the shared egress namespace | 3    | Done - netns-based compose in `renderCompose.ts`; port bound to `127.0.0.1`; fallbacks removed; `seedStackSecrets` in `init.ts`; `spawn.ts` reads `OMNIROUTE_INITIAL_PASSWORD` from the store env; compose invoked with `--env-file .e/.env`; `executeSpawn` gives the run no Compose network |
| 3   | [#26](https://github.com/BelphegorPrime/e/issues/26) | Non-root runtime user in the harness Dockerfile template, per-harness override                                                                               | 1    | Done (see Zone 1 table)                                                                                                                                                                                                                                                                       |
| 4   | [#27](https://github.com/BelphegorPrime/e/issues/27) | Egress hardening (proxy/network policy allowing provider + MCP endpoints only)                                                                               | 1    | Done as a blacklist + monitor instead of an allow-list (ADR-0011, ADR-0012)                                                                                                                                                                                                                   |
| 5   | [#28](https://github.com/BelphegorPrime/e/issues/28) | Verify stale `serve.json` handling in detached mode                                                                                                          | 4    | Done; a corrupt file now reads as stale instead of crashing `e serve`                                                                                                                                                                                                                         |

## References

- ADR-0002 (host orchestrates git; accepted egress + whole-file env injection)
- ADR-0005 (container groups, sidecars, private networks)
- ADR-0006 (per-harness config adapter; `.e/.env` as the secret source)
- `src/init/renderCompose.ts`, `src/init/renderBootstrap.ts`,
  `src/init/renderEgress.ts`, `src/harness/renderDockerfile.ts`,
  `src/store/{config,paths,root}.ts`, `src/serve/serve.ts`, `src/egress/`
- Issues: [#24](https://github.com/BelphegorPrime/e/issues/24) (env whitelist),
  [#25](https://github.com/BelphegorPrime/e/issues/25) (OmniRoute bind + secrets, done),
  [#26](https://github.com/BelphegorPrime/e/issues/26) (non-root container),
  [#27](https://github.com/BelphegorPrime/e/issues/27) (egress),
  [#28](https://github.com/BelphegorPrime/e/issues/28) (stale serve.json)
