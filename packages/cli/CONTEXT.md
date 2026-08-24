# CLI

The `e` command: builds and runs coding-agent harnesses inside containers, one isolated run at a time. This context owns the vocabulary of harnesses, runtimes, and runs.

## Language

**Harness**:
A coding-agent CLI (e.g. Claude Code, Codex, opencode, Pi) packaged to run inside a container built from its own Dockerfile. The _packaging_ only — the model and configuration it runs with belong to an Agent.
_Avoid_: tool, model (a Harness is packaging; the configured capability is an Agent)

**Agent**:
A named, reusable pairing of a Harness with a specific model configuration (provider endpoint, model, credentials) and a Tier — the selectable unit a Run executes (e.g. `smart-claude`, `cheap-codex`). Many Agents can share one Harness. An Agent does not own Sidecars; those are chosen per-Run.
_Avoid_: harness (its packaging), bot, assistant

**Provider**:
The model endpoint an Agent talks to, defined inline in the Agent (not a standalone Store entity): `baseUrl`, `model` (a concrete id or `auto`), `protocol` (the wire API — `openai-chat`, `openai-responses`, or `anthropic-messages`), and `apiKeyEnv` — the _name_ of the env var holding the key (the value lives in `.e/.env`, never in an image). Two fields are optional: `baseUrlEnv` (the _name_ of an env var that overrides `baseUrl` from `.e/.env`, so the endpoint need not be hard-coded in the Agent) and `defaultModel` (a fallback used when `model` is `auto` but resolution finds nothing or the endpoint is unreachable). A Provider's protocol must be one of the set its Harness speaks.
_Avoid_: model, backend, endpoint (informal)

**Sidecar**:
An auxiliary container composed alongside the agent container in a Run and chosen at spawn time — the running form of a `container`-transport MCP server (see below), built from its own Dockerfile under the Store's `mcp/` directory. The agent container is the primary; Sidecars support it over a private per-run network and are torn down with it.
_Avoid_: service, plugin, addon

**MCP server**:
A capability the agent connects to over the Model Context Protocol, chosen per-Run. It has a transport: `container` (built from its own Dockerfile under the Store's `mcp/`, run as a Sidecar on the private per-run network) or `remote` (an already-hosted URL, no container). `e` ships some and users can add their own.
_Avoid_: tool (an MCP server _exposes_ tools; it is not itself a tool)

**Skill**:
A packaged capability (a `SKILL.md` plus resources) an Agent can load, stored under the Store's `skills/`. Selected two ways: an Agent may bake a default set into its image, and a Run may add more at spawn time (`--skill`). Delivered by the per-harness adapter into the path its CLI reads, outside `/workspace`; only harnesses that support skills receive them.
_Avoid_: tool, command, plugin

**Tier**:
A capability/cost class of an Agent — e.g. `smart` (most-capable) vs `cheap` (fastest/cheapest). It has two roles: it selects an Agent (`e spawn <harness> --tier <tier>`), and it is the policy for `auto` model resolution — when an Agent's model is `auto`, `e` picks the best-available model for the tier from the provider's live model list (`/v1/models`). May later also drive automatic routing across Agents.
_Avoid_: level, grade, model

**Run**:
One execution of an Agent against a prompt, isolated in its own git worktree and branch and identified by a prompt-derived slug. A Run may attach Sidecars chosen at spawn time; it brings up the resulting group — the primary agent container plus those Sidecars — on a private network, and tears it down as a group.
_Avoid_: job, task, session

**Runtime**:
The container engine — docker or podman — that builds and runs harness images.
_Avoid_: engine, backend, driver

**Spawn**:
To start a run.
_Avoid_: launch, create, exec

**Store**:
The `.e` directory holding e's on-disk state — the per-harness Dockerfiles under `harnesses/`, the Agent definitions under `agents/<name>/<tier>/` (one subdirectory per tier, each holding that agent's `agent.json` plus any rendered `models.json`/`Dockerfile`), the MCP server definitions under `mcp/`, the Skills under `skills/`, the host-only orchestration settings in `config.json` (e.g. the favorite/default harness — never injected into containers, unlike `.env`), the shared `.env`, and `model-ids.json` (a cached dump of the last `/v1/models` fetch, written for reference during `auto` resolution) — located by walking up from the working directory (or `--dir`), falling back to home.
_Avoid_: workspace (here "workspace" means the npm workspace under `packages/`; the container's mounted checkout is the run's worktree)
