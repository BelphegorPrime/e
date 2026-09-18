# Security Analysis: `e` orchestrator attack surface

Status: review draft, 2026-09-05; egress and BFF sections refreshed 2026-09-11
after ADR-0011/0012 shipped; findings refresh 2026-09-13 after a pass over
the shared egress namespace, the runtime-broker, and the `serve` BFF
(tickets 70-73); harness-CLI findings added 2026-09-17 from the unattended-flags
research (#143). Grounded in the current source
and the ADR set. The goal is a written attack-surface review of the four
execution zones - container, store, local compose stack, and the `serve` BFF -
with concrete, time-boxed recommendations. Implementation of the recommended
fixes is tracked separately (issues with triage labels; new findings as
[`docs/tickets/`](../tickets/README.md) write-ups 70-73); this document is the
analysis, not the patch.

## Threat model

The attacker we harden against is a **compromised or prompt-injected harness
agent**: the container runs the harness CLI unsupervised (each harness with its
own approval bypass - `--dangerously-skip-permissions` for Claude Code,
`--dangerously-bypass-approvals-and-sandbox` for Codex, which also drops its
sandbox, and `--auto` for opencode, which still honours explicit `deny` rules;
see ADR-0002), so anything the agent can reach, it can abuse. The host is
assumed hostile-adjacent for the container: the container must be treated as
untrusted code with full network egress (the model API must be reachable),
limited only by what is mounted and what credentials are present.

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

**Open finding (ticket [`71`](../tickets/71-egress-mutation-api-auth-and-per-run-scope.md)):**
the egress HTTP API (ADR-0012) binds `0.0.0.0:20129` with no authentication,
and the shared netns puts it on every run's loopback. A compromised agent can
`POST`/`DELETE /blacklist/domains` on the **global** blacklist and SIGHUP
dnsmasq - sinkholing another run's provider or MCP endpoints (cross-run DoS),
removing operator-added entries, or reading every run's DNS query names via
`GET /logs`. `NET_ADMIN` is not the only write path to the policy; the API is.
Fix direction: mutation auth (a token the agent never holds), per-run
blacklist scope, or refusing mutation from the run.

**Open finding (ticket [`73`](../tickets/73-broker-authz-and-port-collision-in-shared-netns.md)):**
the runtime-broker (ADR-0013) trusts network isolation: no auth, fixed port
`20130`. In the shared egress namespace isolation fails - any run reaches any
other run's broker on its loopback and can spool/signal foreign sibling
requests, and two brokers collide on the fixed port (second bind fails, which
`runSpawn.ts` already half-anticipates). Fix direction: per-run loopback
port, per-run broker token, or refuse sibling support in the shared netns.

**Open finding ([#153](https://github.com/BelphegorPrime/e/issues/153)):** the
harness CLIs execute configuration supplied by the mounted repository. Claude
Code run without `--bare` runs the hooks in a project's
`.claude/settings.json` and connects the servers in its `.mcp.json` - per its
own headless docs, "even in a folder you've never trusted". `e` bind-mounts an
arbitrary repository at `/workspace` and invokes
`claude -p <prompt> --dangerously-skip-permissions`, so a hostile repository
gets code execution inside the run container with no prompt injection and no
agent decision involved: cloning it is enough. The container boundary still
holds (non-root, no host socket, egress containment), so the blast radius is
what Zone 1 already grants an untrusted agent - but it is reached
automatically rather than by persuading a model, and it chains into the two
open cross-run findings above (`71`, `73`), where one run's code reaches
another run's egress policy and broker. The threat model's "supply chain of
the harness image" non-goal does not cover this: the input is the work
repository, not the image. This matters more the moment runs start without a
human looking: a trigger that spawns a run on an incoming pull request would
execute the fork's hooks. Fix direction: pass `--bare` (or the per-harness
equivalent) and deliver the MCP servers and hooks `e` intends from the Store
overlay it already mounts read-only, rather than from `/workspace`.

**Open finding, secrets egress (#153):** opencode's `--share` publishes the
session transcript publicly at `opncd.ai/s/<id>`, and it can be turned on by
environment alone via `OPENCODE_AUTO_SHARE`. `e` does not pass `--share`
(`src/core/harness/index.ts:196`), and the `.e/.env` whitelist
(`baseEnvWhitelist`, `src/engine/spawn/spawnPlan.ts:587`) means the variable
only reaches a container if someone declares it - so this is currently
contained by two accidents rather than by a rule. Worth writing the rule down:
`OPENCODE_AUTO_SHARE` never joins the whitelist, and `--share` never joins the
argv. A shared session carries the whole prompt and every file the agent
quoted.

**Note, availability rather than attack:** Codex (`lib.rs:1908-1912`) and
opencode (`run.ts:416`) both read stdin to EOF when stdin is not a TTY, even
when the prompt arrives as an argv argument. `e` is safe only because a
one-shot run passes neither `-i` nor `-t`; any future change that adds `-i`
(streaming input, an interactive-ish variant) makes both harnesses hang before
they ever contact the API. Worth a comment at the spawn site rather than a
fix.

## Zone 2: Store and secrets

| Fact                                                                                                                                                                                                                                                                                              | Status                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `.e/.env` (home or `--dir` root) is the sole secret source (ADR-0006); git-ignored                                                                                                                                                                                                                | Good                                                                                                       |
| Secrets are rendered into per-run scratch env-files, disposed after the run                                                                                                                                                                                                                       | Good                                                                                                       |
| API keys are never baked into agent images (env-file delivery)                                                                                                                                                                                                                                    | Good                                                                                                       |
| Base `.e/.env` container injection is filtered to declared provider/MCP keys (`baseEnvWhitelist`, `filterEnvContent` in `executeSpawn`)                                                                                                                                                           | **Fixed**                                                                                                  |
| `.e/.env` host file mode: every writer uses plain `fs.writeFileSync` (init via `writeIfAbsent`, `prepareLocalStack`, `localApiKey`), so under umask 022 the file lands **0644** - world-readable on the host, holding provider keys, `OMNIROUTE_INITIAL_PASSWORD`, `JWT_SECRET`, `API_KEY_SECRET` | **Open** - ticket [`72`](../tickets/72-secrets-files-0600-on-host.md): write 0600, chmod-existing-on-touch |

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
`.e/.env` (`seedStackSecrets` in `src/cli/init/initPlan.ts`). `e spawn` passes `.e/.env` to
`docker compose --env-file` so the ${VAR} interpolation picks the seeded
values; the `spawn.ts` sign-in prompt and unconfigured-key check read
`OMNIROUTE_INITIAL_PASSWORD` from the store env instead of the old literal.
The stack secrets stay out of harness containers: they are not in
`baseEnvWhitelist` (Zone 2), so the injection filter keeps them host-side even
though they now live in `.e/.env`.

llama.cpp already binds localhost correctly and runs as its own service; Redis
is scoped to the compose network. No change needed there.

## Zone 4: `serve` (the BFF per the architecture review)

| Fact                                                                                                                                                                                                                                                              | Status                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Express server binds `127.0.0.1` by default                                                                                                                                                                                                                       | Good                                                                              |
| Serves the bundled static UI and `/api/health`, `/api/info`                                                                                                                                                                                                       | Good                                                                              |
| Detached mode spawns a background `node` process, tracked via `serve.json`                                                                                                                                                                                        | Note                                                                              |
| Per the architecture review: becomes a BFF proxying OmniRoute (and runs/status from git refs), key read host-side from `.e/.env`, never sent to the browser                                                                                                       | Agreed                                                                            |
| Browser terminal (ADR-0014): `POST /api/terminal/sessions` starts a headless `e spawn` child; the run container's TTY is attached through the engine's unix socket from the `serve` process only - the socket is never exposed to the browser or a container      | Note                                                                              |
| Terminal WebSocket (`/api/terminal/ws`) rejects upgrades whose `Origin` does not name the serving host; browsers skip same-origin for WebSockets, so this is what keeps another open page from typing into a run                                                  | Good                                                                              |
| `serve` needs no engine socket to run; without one the terminal routes refuse to start sessions and `/api/info.terminal` is false                                                                                                                                 | Good                                                                              |
| A2A endpoint (ADR-0015): `POST /a2a` starts a headless `e spawn` child per task, like the terminal; open on loopback, bearer-protected with `E_A2A_TOKEN`, and **disabled** (card 404, endpoint 503) when `serve` is bound beyond loopback without a token        | Good                                                                              |
| The agent card lists Store agent names (not secrets); remote A2A agents' `${VAR}` headers resolve host-side from `.e/.env` at call time and never reach a container, an image, or the card                                                                        | Good                                                                              |
| Beyond loopback only A2A is bearer-guarded: `a2aAccess` gates the `/a2a` RPC alone; terminal sessions, the manual-child POST, the runs index and the egress proxy stay **unauthenticated** on any interface (all mounted in `serveApp.ts` before any token check) | **Open** - ticket [`70`](../tickets/70-serve-authenticate-bff-beyond-loopback.md) |

The BFF keeps secrets server-side, so the browser UI does not expand the
secret exposure. Keep the localhost bind; do not add auth while it holds (the
UI observes, plus three delegated writes: egress blacklisting, starting a run
from the terminal, and starting a run over A2A, none of which grants the local
user a capability `e spawn` did not). Binding `serve` beyond loopback is the
point where auth becomes required (ADR-0014); today only the A2A endpoint
enforces that (ADR-0015: bearer token or off) - the terminal, manual-child and
egress-proxy routes do not, so `--host` beyond loopback must gate the whole
app, not just `/a2a` (ticket [`70`](../tickets/70-serve-authenticate-bff-beyond-loopback.md)). One caution for the detached mode: `serve.json` holds a
pid/host/port in `$HOME/.e` and `E_SERVE_DETACHED` gates re-detachment -
verify a stale pid (host reboot) is handled today or add a health check before
reporting "already serving".

## Recommended fixes, in priority order

| #   | Issue                                                                                 | Fix                                                                                                                                                                                           | Zone | When                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [#24](https://github.com/BelphegorPrime/e/issues/24)                                  | Whitelist `.e/.env` injection to declared provider/MCP keys                                                                                                                                   | 2    | Done - `baseEnvWhitelist` filter in `planSpawn`/`executeSpawn`, unblocks #2                                                                                                                                                                                                                   |
| 2   | [#25](https://github.com/BelphegorPrime/e/issues/25)                                  | Bind OmniRoute to `127.0.0.1:20128` with no default secrets; `e init` generates stack secrets; the run reaches OmniRoute through the shared egress namespace                                  | 3    | Done - netns-based compose in `renderCompose.ts`; port bound to `127.0.0.1`; fallbacks removed; `seedStackSecrets` in `init.ts`; `spawn.ts` reads `OMNIROUTE_INITIAL_PASSWORD` from the store env; compose invoked with `--env-file .e/.env`; `executeSpawn` gives the run no Compose network |
| 3   | [#26](https://github.com/BelphegorPrime/e/issues/26)                                  | Non-root runtime user in the harness Dockerfile template, per-harness override                                                                                                                | 1    | Done (see Zone 1 table)                                                                                                                                                                                                                                                                       |
| 4   | [#27](https://github.com/BelphegorPrime/e/issues/27)                                  | Egress hardening (proxy/network policy allowing provider + MCP endpoints only)                                                                                                                | 1    | Done as a blacklist + monitor instead of an allow-list (ADR-0011, ADR-0012)                                                                                                                                                                                                                   |
| 5   | [#28](https://github.com/BelphegorPrime/e/issues/28)                                  | Verify stale `serve.json` handling in detached mode                                                                                                                                           | 4    | Done - a stale pid or dead server falls through to starting a fresh one and the state file is cleared (ticket 32)                                                                                                                                                                             |
| 6   | Local ticket [`70`](../tickets/70-serve-authenticate-bff-beyond-loopback.md)          | Authenticate the whole BFF when `--host` binds beyond loopback (reuse `E_A2A_TOKEN` or a dedicated `E_SERVE_TOKEN`); terminal, manual-child, runs-index and egress-proxy routes join the gate | 4    | Open - only `/a2a` is bearer-guarded today; do before exposing `serve --host` to a real network                                                                                                                                                                                               |
| 7   | Local ticket [`71`](../tickets/71-egress-mutation-api-auth-and-per-run-scope.md)      | Add mutation auth to the egress API (token the agent never holds) and/or per-run blacklist scope; monitor reads may stay open with a documented trade-off                                     | 1    | Open - a compromised agent can sinkhole the global blacklist and read every run's DNS queries; ship before relying on blacklist enforcement across runs                                                                                                                                       |
| 8   | Local ticket [`72`](../tickets/72-secrets-files-0600-on-host.md)                      | Write `.e/.env` 0600 via one `writeSecretFile` helper; chmod an existing too-open file on the next write                                                                                      | 2    | Open - cheap, host-local payoff; no new boundaries                                                                                                                                                                                                                                            |
| 9   | Local ticket [`73`](../tickets/73-broker-authz-and-port-collision-in-shared-netns.md) | Broker isolation in the shared egress namespace: per-run loopback port, per-run token, or refuse sibling support there; resolve the fixed `BROKER_PORT` collision                             | 1    | Open - two spawn-brother runs in one netns collide today; cross-run spool/signal reach is the deeper fix                                                                                                                                                                                      |
| 10  | [#153](https://github.com/BelphegorPrime/e/issues/153)                                | Stop the harness executing `/workspace`-supplied config: `--bare` (or per-harness equivalent) plus Store-delivered MCP servers and hooks                                                      | 1    | Open - a hostile repository gets container code execution without prompt injection; do before any trigger spawns runs on unreviewed code                                                                                                                                                      |
| 11  | [#153](https://github.com/BelphegorPrime/e/issues/153)                                | Write down the opencode sharing rule: `OPENCODE_AUTO_SHARE` never joins the env whitelist, `--share` never joins the argv                                                                     | 1    | Open - contained today by two accidents rather than by a rule; a shared session is public at `opncd.ai/s/<id>`                                                                                                                                                                                |

## References

- ADR-0002 (host orchestrates git; accepted egress + whole-file env injection)
- ADR-0005 (container groups, sidecars, private networks)
- ADR-0006 (per-harness config adapter; `.e/.env` as the secret source)
- `src/cli/init/renderCompose.ts`, `src/cli/init/renderBootstrap.ts`,
  `src/sidecars/egress/render.ts`, `src/core/harness/renderDockerfile.ts`,
  `src/core/store/{config,paths,root}.ts`, `src/cli/serve/detachedServe.ts`, `src/sidecars/egress/`
- Issues: [#24](https://github.com/BelphegorPrime/e/issues/24) (env whitelist),
  [#25](https://github.com/BelphegorPrime/e/issues/25) (OmniRoute bind + secrets, done),
  [#26](https://github.com/BelphegorPrime/e/issues/26) (non-root container),
  [#27](https://github.com/BelphegorPrime/e/issues/27) (egress),
  [#28](https://github.com/BelphegorPrime/e/issues/28) (stale serve.json)
- New findings (2026-09-13, GitHub pending): [`70`](../tickets/70-serve-authenticate-bff-beyond-loopback.md) (BFF auth beyond
  loopback), [`71`](../tickets/71-egress-mutation-api-auth-and-per-run-scope.md) (egress mutation API auth),
  [`72`](../tickets/72-secrets-files-0600-on-host.md) (`.e/.env` 0600), [`73`](../tickets/73-broker-authz-and-port-collision-in-shared-netns.md)
  (broker authz + port collision in the shared netns)
- Harness-CLI findings (2026-09-17): [#153](https://github.com/BelphegorPrime/e/issues/153)
  (workspace-supplied hooks and MCP config, opencode session sharing); full
  write-up in [`../research/harness-unattended-flags.md`](../research/harness-unattended-flags.md).
  Related correctness bug: [#152](https://github.com/BelphegorPrime/e/issues/152)
  (`codex exec` read-only sandbox) - **fixed**; Codex and opencode now carry
  their bypass flags, which widens Zone 1 to what this threat model already
  assumed
