# Security Analysis: `e` orchestrator attack surface

Status: review draft, 2026-09-05. Grounded in the current `packages/cli` source
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

| Fact | Status |
| ---- | ------ |
| Runs as **root** (harness Dockerfile has no `USER`; `node:lts-alpine` default) with full caps, no drops | **Finding** |
| No `docker.sock` (or any host socket) is mounted | Good |
| Git credentials never enter the container; all git runs host-side (ADR-0002) | Good |
| The run worktree is bind-mounted at `/workspace` read-write | By design |
| Config overlays (Codex config, skills) are mounted read-only outside `/workspace` | Good |
| Sidecar MCP servers join a private per-run network; the primary joins it only when sidecars exist | Good |
| Full network egress (only the model API is *needed*) | **Finding** (ADR-0002 deferred gap) |
| `.e/.env` injected whole into every container, unfiltered | Fixed — whitelisted (see Zone 2) |

Root in the container is the highest-value finding: the hardening work is
relatively mechanical (a non-root user in the Dockerfile template, plus wiring
the run to use it) and removes an entire class of container-escape
amplifications. The `USER` decision must be per-harness — some harness CLIs
write to their config/home dirs at runtime — so the Dockerfile template needs a
"runtime user" parameter defaulting to a non-root uid, with the harness
registry able to override where needed.

Egress hardening (only allow the provider base URL and configured MCP
endpoints) is the second finding, but it is architecturally significant:
Docker has no native egress firewall, so it needs a proxy container or network
policy on the run group. It is the least-urgent of the three because the agent
must reach its model API anyway and credential exposure is already bounded by
Zone-2 fixes.

## Zone 2: Store and secrets

| Fact | Status |
| ---- | ------ |
| `.e/.env` (home or `--dir` root) is the sole secret source (ADR-0006); git-ignored | Good |
| Secrets are rendered into per-run scratch env-files, disposed after the run | Good |
| API keys are never baked into agent images (env-file delivery) | Good |
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

| Fact | Status |
| ---- | ------ |
| OmniRoute dashboard/API binds **`0.0.0.0:20128`** in `renderCompose.ts` | **Finding** |
| Default secrets baked into compose: `INITIAL_PASSWORD=local-development`, `JWT_SECRET=local-development-jwt-secret-32-bytes`, `API_KEY_SECRET=local-development-api-key-secret-32-bytes` | **Finding** |
| llama.cpp binds `127.0.0.1:9931` host-side | Good |
| Redis is exposed only on the compose network, with a healthcheck | Good |
| The stack is started by `e spawn` automatically when `.e/compose.yaml` exists | User choice (configurable, see architecture review) |

The 0.0.0.0 bind plus hardcoded default credentials is the gap that matters on
the host network: on an untrusted LAN any machine can open the OmniRoute
dashboard and log in with the well-known default password. Fix (agreed in the
architecture review, **not implemented yet** — tracked as an issue, blocked by
the `.e/.env` whitelist below):

1. Bind the OmniRoute port to `127.0.0.1` in `renderCompose.ts`.
2. Stop baking default secrets: `e init` generates a random
   `INITIAL_PASSWORD` (and JWT/API-key secrets) into `.e/.env` (the compose
   stack reads them via `${VAR}` interpolation; the bootstrap script already
   consumes `$INITIAL_PASSWORD`). A fallback in the template is removed
   rather than kept, so a fresh init has no well-known default.
3. The hardcoded `local-development` references in `spawn.ts` (sign-in prompt
   and accepted-key check) read the generated password from the store env.

Ordering note: this fix was **blocked by** the whitelist fix in Zone 2, which has now landed (#24): `.e/.env` can gain the OmniRoute secrets because a container no longer receives them — injection filtering is in, so the secret randomization and the port bind are next.

llama.cpp already binds localhost correctly and runs as its own service; Redis
is scoped to the compose network. No change needed there.

## Zone 4: `serve` (the BFF per the architecture review)

| Fact | Status |
| ---- | ------ |
| Express server binds `127.0.0.1` by default | Good |
| Serves the bundled static UI and `/api/health`, `/api/info` | Good |
| Detached mode spawns a background `node` process, tracked via `serve.json` | Note |
| Per the architecture review: becomes a BFF proxying OmniRoute (and runs/status from git refs), key read host-side from `.e/.env`, never sent to the browser | Agreed |

The BFF keeps secrets server-side, so a future read-only browser UI does not
expand the secret exposure. Keep the localhost bind; do not add auth (the UI
is a local observer). One caution for the detached mode: `serve.json` holds a
pid/host/port in `$HOME/.e` and `E_SERVE_DETACHED` gates re-detachment —
verify a stale pid (host reboot) is handled today or add a health check before
reporting "already serving".

## Recommended fixes, in priority order

| # | Issue | Fix | Zone | When |
| - | ----- | --- | ---- | ---- |
| 1 | [#24](https://github.com/BelphegorPrime/e/issues/24) | Whitelist `.e/.env` injection to declared provider/MCP keys | 2 | Done — `baseEnvWhitelist` filter in `planSpawn`/`executeSpawn`, unblocks #2 |
| 2 | [#25](https://github.com/BelphegorPrime/e/issues/25) | Bind OmniRoute to `127.0.0.1:20128` with no default secrets; `e init` generates stack secrets | 3 | After #1 — `ready-for-agent`, blocked by #1 |
| 3 | [#26](https://github.com/BelphegorPrime/e/issues/26) | Non-root runtime user in the harness Dockerfile template, per-harness override | 1 | `ready-for-agent` |
| 4 | [#27](https://github.com/BelphegorPrime/e/issues/27) | Egress hardening (proxy/network policy allowing provider + MCP endpoints only) | 1 | `ready-for-agent` |
| 5 | [#28](https://github.com/BelphegorPrime/e/issues/28) | Verify stale `serve.json` handling in detached mode | 4 | `ready-for-agent` |

## References

- ADR-0002 (host orchestrates git; accepted egress + whole-file env injection)
- ADR-0005 (container groups, sidecars, private networks)
- ADR-0006 (per-harness config adapter; `.e/.env` as the secret source)
- `packages/cli/src/renderCompose.ts`, `renderBootstrap.ts`,
  `harness/renderDockerfile.ts`, `store.ts`, `serve.ts`
- Issues: [#24](https://github.com/BelphegorPrime/e/issues/24) (env whitelist),
  [#25](https://github.com/BelphegorPrime/e/issues/25) (OmniRoute bind + secrets),
  [#26](https://github.com/BelphegorPrime/e/issues/26) (non-root container),
  [#27](https://github.com/BelphegorPrime/e/issues/27) (egress),
  [#28](https://github.com/BelphegorPrime/e/issues/28) (stale serve.json)