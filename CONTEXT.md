# CLI

The `e` command: builds and runs coding-agent harnesses inside containers, one isolated run at a time. This context owns the vocabulary of harnesses, runtimes, and runs.

## Language

**Harness**:
A coding-agent CLI (e.g. Claude Code, Codex, opencode, Pi) packaged to run inside a container built from its own Dockerfile. The _packaging_ only - the model and configuration it runs with belong to an Agent.
_Avoid_: tool, model (a Harness is packaging; the configured capability is an Agent)

**Agent**:
A named, reusable pairing of a Harness with a specific model configuration (provider endpoint, model, credentials) - the selectable unit a Run executes (e.g. `smart-claude`, `cheap-codex`). Many Agents can share one Harness. An Agent does not own Sidecars; those are chosen per-Run.
_Avoid_: harness (its packaging), bot, assistant

**Provider**:
The model endpoint an Agent talks to, defined inline in the Agent (not a standalone Store entity): `baseUrl`, `model` (a concrete id or `auto`), `protocol` (the wire API - `openai-chat`, `openai-responses`, or `anthropic-messages`), and `apiKeyEnv` - the _name_ of the env var holding the key (the value lives in `.e/.env`, never in an image). One field is optional: `baseUrlEnv` (the _name_ of an env var that overrides `baseUrl` from `.e/.env`, so the endpoint need not be hard-coded in the Agent); when `model` is `auto`, the harness resolves a concrete model against the endpoint at run start (ADR-0007). A Provider's protocol must be one of the set its Harness speaks.
_Avoid_: model, backend, endpoint (informal)

**Sidecar**:
An auxiliary container composed alongside the agent container in a Run and chosen at spawn time - the running form of a `container`-transport MCP server (see below), built from its own Dockerfile under the Store's `mcp/` directory, or the Runtime-broker (below), built from `.e/broker/`. The agent container is the primary; Sidecars support it over a private per-run network and are torn down with it.
_Avoid_: service, plugin, addon

**MCP server**:
A capability the agent connects to over the Model Context Protocol, chosen per-Run. It has a transport: `container` (built from its own Dockerfile under the Store's `mcp/` directory). Located by walking up from the working directory (or `--dir`), falling back to home.
_Avoid_: service, plugin

**Skill**:
A capability directory with `SKILL.md` manifest and resources. Located by walking up from the working directory (or `--dir`), falling back to home.
_Avoid_: plugin, addon

The next seven terms are the vocabulary of ADR-0013 (proposed; implemented so far: the run-role contract of ticket 01 and the broker sidecar with its `spawn-brother` skill of ticket 02; the host side that executes sibling requests is not):

**Runtime-broker**:
A sidecar (image `e-broker`, build context `.e/broker/`, alias `runtime-broker`, port 20130) that exposes the sibling-spawn HTTP contract (`POST /spawn`, `GET /status`) to agent containers over the run's network, and nothing else. It holds **no** container-runtime socket and no credentials (ADR-0002): it spools each request as a file into the run's **spool**, a host-owned directory bind-mounted into it, and serves back the status the host writes there. The host `e` process stays the only party that runs containers or git (ADR-0013 as refined by ticket 02). Planned for a Run exactly when the Run carries the `spawn-brother` skill.
**Sibling run**:
A child run requested from inside a parent run via its runtime-broker. Siblings execute on the parent run's private network + lifecycle and share its worktree branch only through the host's checkpoint-before-spawn + merge-back protocol (ADR-0001, ADR-0013). Depth is capped: children may request siblings, never children of children.
**Checkpoint**:
The host-side `git commit -a` of a parent worktree's WIP to its run branch immediately before spawning a sibling, so the sibling's worktree branch starts from the parent's current state (ADR-0001 only carries committed refs; ADR-0013). Zero file-content movement - the worktree is the live bind-mount of the parent's `/workspace`. The primitive is `runSpawn`'s `parent` option (`src/runs/runSpawn.ts`): `commitAll` on the parent worktree when dirty, then the sibling branches from `headSha(parentWorktree)`; the host side that calls it for a spooled sibling request is ticket 06.
**Merge-back**:
The host-side merge of a sibling's branched work back into the parent worktree after the sibling exits. Delivered as a merge commit whose files are reflected in the parent's live `/workspace`; on conflict the host folds the parent's current WIP into the merge and reports conflict markers for the parent agent to resolve (ADR-0013). Never uses git from inside the container. The primitive is `Git.merge` (`src/git/index.ts`): always a merge commit, and a conflict is a returned outcome with the conflicted paths, the merge left in progress with its markers.
**Run role**:
A container's place in a Run's tree, `parent` or `child`, delivered as host-set env: `E_ROLE`, with `E_BROKER_URL` naming the runtime-broker endpoint (by alias `runtime-broker` on a private run network, on loopback in the shared egress namespace) - never an image layer or a marker file in the worktree (ADR-0013; `src/runs/runRole.ts`). The `e spawn` process learns the role it hands out from its internal `E_SPAWN_ROLE` marker; unset means `parent`.
**Spool**:
The host-owned directory of one Run (`<worktreesDir>/.broker/<runName>`) bind-mounted into its Runtime-broker at `/var/lib/e-broker`: `run.json` (the Run's identity, written by the host before the broker starts), `requests/<id>.json` (written by the broker for each `POST /spawn`), `status/<id>.json` (written by the host as it handles a request). The only channel between broker and host - no socket, no network from the host side; removed with the Run unless `--keep-worktree`.
**Artifact sync**:
The host-side copy of allowlisted build artifacts (`siblingArtifacts` in `config.json`, default `node_modules`) from a parent worktree into a Sibling run's scratch dir (`<worktreesDir>/.artifacts/<runName>`), bind-mounted at the same `/workspace/<entry>` path in the sibling's container - beside its worktree, never inside it (ADR-0013; `src/runs/runArtifacts.ts`). Reflink where the filesystem allows, plain copy otherwise; only real paths inside the worktree are synced (a symlinked entry is refused), and `.git`, `.env` and `.env.*` never travel (ADR-0002).

**Run**:
A RunScratch + primary container + sidecars, the unit that executes an Agent. With the local stack present, agent and sidecars share the global `e-egress` network namespace (ADR-0011); otherwise sidecars sit on a private per-run network. The pure description of a run is a `SpawnPlan` (`src/spawn/spawnPlan.ts`); `runSpawn` (`src/runs/runSpawn.ts`) executes it. Container configuration is a `RunOptions` (below).

**Runtime**:
The container engine that builds and runs harness images - any engine whose CLI matches Docker's: `docker`, `podman`, `nerdctl`, or `finch` (the registry in `src/runtime/registry.ts`; desktop products such as Docker Desktop, OrbStack, Colima, Rancher Desktop, Podman Desktop, and Finch provide one of them). Selected by `--runtime`, then `E_RUNTIME`, then the first one on `PATH`. Engines with a different command surface (Apple `container`, Docker `sbx`) are not Runtimes; they would need their own `ContainerRunner` adapter.
_Avoid_: naming a desktop product as a runtime (it is the CLI it installs that counts)

**Spawn**:
To start a run - includes planning phase with container configuration.

**Store** (_eBaseDir_):
The `.e` directory holding e's on-disk state - **also called "eBaseDir" because it's the mountpoint for code in the harness docker container**

- Per-harness Dockerfiles under `harnesses/`
- Agent definitions under `agents/<name>/` (each holding agent's `agent.json` plus any rendered `models.json`/`Dockerfile`)
- MCP server definitions under `mcp/`
- Skills under `skills/`
- Host-only orchestration settings in `config.json` (the favorite/default harness, the git platform for PR/MR creation - never injected into containers, unlike `.env`)
- The shared `.env`
- `model-ids.json` (a cached model registry, currently unused by the run paths)
- Located by walking up from the working directory (or `--dir`), falling back to home
- Avoid: calling it "workspace" in the Store context (the container's mounted checkout is the run's worktree)

## Additional Implementation Concepts

**Mount**:
Bind mount structure: host -> container -> ro? boolean

**RunOptions**:
Container configuration options (`src/runtime/index.ts`):

- `name`: string?
- `interactive`: boolean? (keep stdin open, allocate a TTY)
- `headlessTty`: boolean? (with `interactive`: `run -d -it` then `wait`, for a caller without a host TTY that attaches through the engine API - ADR-0014)
- `port`: string[]? (`-p` publishes)
- `env`: string[]? (`-e` entries)
- `envFile`: string[]? (`--env-file`, in order)
- `rm`: boolean?
- `volumes`: Mount[]?
- `workdir`: string?
- `networks`: string[]? (mutually exclusive with `netns`)
- `netns`: string? (`--network container:<name>`, the shared egress namespace)
- `extraHosts`: string[]?

**ContainerRuntime**:
Runtime instance driving one Docker-CLI-compatible executable (`src/runtime/index.ts`)

**Worktrees dir**:
The host directory run worktrees are created in (`src/runs/worktreesDir.ts`): `E_WORKTREES_DIR`, else the platform default - the temp dir on Linux, `~/Library/Caches/e/worktrees` on macOS, `%LOCALAPPDATA%\e\worktrees` on Windows - chosen so the engine's VM can bind-mount it

**RunScratch**:
Temporary workspace

**HarnessAdapter** (`EnvHarnessAdapter | FileHarnessAdapter`):
Per-harness config translation (`src/harness/adapter.ts`)

**Protocol**:
'openai-chat', 'anthropic-messages', 'openai-responses'

**Host ports**:
The `Git` and `PullRequest` interfaces (`src/git/index.ts`, `src/github/index.ts`), implemented host-side by `HostGit` and `HostPullRequest`

**Egress**:
Network egress management

**ModelStatus**:
Model status tracking

**Serve**:
Server management and observation. The BFF for the web UI (ADR-0010); also hosts the browser terminal (below).

**Terminal session**:
A run started from the web UI (ADR-0014): one headless `e spawn <agent> --name <slug>` child of `serve` whose container TTY `serve` attaches to through the container engine's API and relays to browser tabs over a WebSocket. Phases `starting` (child output: build, worktree) → `attached` (the harness TUI) → `exited` (the child's exit code, after commit/push). Lives in the `serve` process; the run itself does not depend on it.
_Avoid_: shell (it is the harness's TTY, not a host shell), console
