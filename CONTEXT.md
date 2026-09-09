# CLI
The `e` command: builds and runs coding-agent harnesses inside containers, one isolated run at a time. This context owns the vocabulary of harnesses, runtimes, and runs.
## Language
**Harness**:
A coding-agent CLI (e.g. Claude Code, Codex, opencode, Pi) packaged to run inside a container built from its own Dockerfile. The _packaging_ only — the model and configuration it runs with belong to an Agent.
_Avoid_: tool, model (a Harness is packaging; the configured capability is an Agent)

**Agent**:
A named, reusable pairing of a Harness with a specific model configuration (provider endpoint, model, credentials) — the selectable unit a Run executes (e.g. `smart-claude`, `cheap-codex`). Many Agents can share one Harness. An Agent does not own Sidecars; those are chosen per-Run.
_Avoid_: harness (its packaging), bot, assistant

**Provider**:
The model endpoint an Agent talks to, defined inline in the Agent (not a standalone Store entity): `baseUrl`, `model` (a concrete id or `auto`), `protocol` (the wire API — `openai-chat`, `openai-responses`, or `anthropic-messages`), and `apiKeyEnv` — the _name_ of the env var holding the key (the value lives in `.e/.env`, never in an image). One field is optional: `baseUrlEnv` (the _name_ of an env var that overrides `baseUrl` from `.e/.env`, so the endpoint need not be hard-coded in the Agent); when `model` is `auto`, the harness resolves a concrete model against the endpoint at run start (ADR-0007). A Provider's protocol must be one of the set its Harness speaks.
_Avoid_: model, backend, endpoint (informal)

**Sidecar**:
An auxiliary container composed alongside the agent container in a Run and chosen at spawn time — the running form of a `container`-transport MCP server (see below), built from its own Dockerfile under the Store's `mcp/` directory. The agent container is the primary; Sidecars support it over a private per-run network and are torn down with it.
_Avoid_: service, plugin, addon

**MCP server**:
A capability the agent connects to over the Model Context Protocol, chosen per-Run. It has a transport: `container` (built from its own Dockerfile under the Store's `mcp/` directory). Located by walking up from the working directory (or `--dir`), falling back to home.
_Avoid_: service, plugin

**Skill**:
A capability directory with `SKILL.md` manifest and resources. Located by walking up from the working directory (or `--dir`), falling back to home.
_Avoid_: plugin, addon

**Run**:
A RunScratch + primary container + sidecars over private network — the unit that executes an Agent. Includes mount structure: host -> container -> ro? boolean and container configuration options:
- `attach`: boolean
- `interactive`: boolean
- `networks`: object
- `netns`: string?
- `ports`: Record<string, string>
- `env`: Record<string, string>
- `volumes`: Mount[]
- `workDir`: string

**Runtime**:
The container engine — docker or podman — that builds and runs harness images. Runtime instance with docker/podman commands.

**Spawn**:
To start a run — includes planning phase with container configuration.

**Store** (*Workspace*):
The `.e` directory holding e's on-disk state — **also called "Workspace" because it's the mountpoint for code in the harness docker container**
- Per-harness Dockerfiles under `harnesses/`
- Agent definitions under `agents/<name>/` (each holding agent's `agent.json` plus any rendered `models.json`/`Dockerfile`)
- MCP server definitions under `mcp/`
- Skills under `skills/`
- Host-only orchestration settings in `config.json` (the favorite/default harness, the git platform for PR/MR creation — never injected into containers, unlike `.env`)
- The shared `.env`
- `model-ids.json` (a cached model registry, currently unused by the run paths)
- Located by walking up from the working directory (or `--dir`), falling back to home
- Avoid: calling it "workspace" in the Store context (the container's mounted checkout is the run's worktree)

## Additional Implementation Concepts

**Mount**:
Bind mount structure: host -> container -> ro? boolean

**RunOptions**:
Container configuration options:
- `attach`: boolean
- `interactive`: boolean
- `networks`: object
- `netns`: string?
- `ports`: Record<string, string>
- `env`: Record<string, string>
- `volumes`: Mount[]
- `workDir`: string

**ContainerRuntime**:
Runtime instance with docker/podman commands

**RunScratch**:
Temporary workspace

**ConfigAdapter**:
Per-harness config translation

**Protocol**:
'openai-chat', 'anthropic-messages', 'openai-responses'

**Harbors**:
HostGit, HostPullRequest interfaces

**Egress**:
Network egress management

**ModelStatus**:
Model status tracking

**Serve**:
Server management and observation