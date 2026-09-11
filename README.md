# `e` - coding-agent harness runner

`e` builds and runs coding-agent harnesses (Claude Code, Codex, opencode, **pi**)
inside containers, one isolated run per git worktree. This README is the
hands-on guide to building it and trying a harness locally. For the concepts
(Harness, Agent, Provider, Sidecar, Run, …) see [CONTEXT.md](./CONTEXT.md); for
the design rationale see [docs/adr/](./docs/adr/); for the agent-facing guide
to delegating work with `e` and `e spawn` see
[docs/agents/e.md](./docs/agents/e.md).

## Why `e` exists: the `e` / `pi` relationship

`pi` is the underlying coding-agent harness: the agent that actually thinks and
edits. `e` is the orchestration layer around the harness: it builds harness
images, isolates each run in its own git worktree and container, delivers the
right provider/model configuration, and collects results as git branches and
PR/MRs. `e` runs harnesses (pi, Claude Code, Codex, opencode), and pi is the
primary one. `e` is named for Euler's number, the mathematical partner of `pi`:
`e` stands around the harness and drives it, the same way the constants `e`
and `π` sit side by side in Euler's identity.

```text
User
  │
  ▼
pi
  │
  ▼
e
  │
  ├── Agent A
  │     ├── Agent A.1
  │     └── Agent A.2
  │
  ├── Agent B
  │
  └── Agent C
```

The user drives `pi`; `pi` delegates through `e`; each spawned agent runs its
own isolated run and can itself spawn further agents (`e spawn` is not limited
to one parent/child level). The docs below are the hands-on build guide; an AI
agent that needs to know how to delegate, what a spawned run provides, and how
results flow back should read [docs/agents/e.md](./docs/agents/e.md).

## Install

`e` is a single host-side binary. It needs three things on the host: `git`, a
container engine that speaks the Docker CLI, and (for pushes and PR/MRs) your
git credentials plus the platform CLI. Everything else - the harness CLIs, the
skills, the model gateway - runs in containers `e` builds.

### Prerequisites (all platforms)

| Dependency                      | Why                                                                                                                                           | Required                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `git` 2.20+                     | Each run is a git worktree on its own branch (ADR-0001); the host commits and pushes (ADR-0002)                                               | yes                      |
| A container engine              | Builds harness images, runs the agent container, sidecars, and the local stack. See [Container runtimes](#container-runtimes) for the choices | yes                      |
| Compose v2 (`<engine> compose`) | Only for the local OmniRoute/egress stack `e init` renders (`.e/compose.yaml`); runs without the stack need no Compose                        | for the local stack      |
| `gh` or `glab`                  | Opens the PR/MR after a successful run (GitHub/Forgejo/Gitea via `gh`, GitLab via `glab`); must be authenticated on the host                  | for PR/MR creation       |
| Node.js 24+ and npm             | Only to build `e` from source or run the tests; the prebuilt binaries embed their own Node runtime                                            | for building from source |

### Prebuilt binaries

Every tagged release on the
[GitHub Releases page](https://github.com/BelphegorPrime/e/releases) ships six
archives, one per target: `e-linux-x64.tar.gz`, `e-linux-arm64.tar.gz`,
`e-macos-x64.tar.gz`, `e-macos-arm64.tar.gz`, `e-win-x64.zip`, and
`e-win-arm64.zip`. Each unpacks to a single `e` (or `e.exe`) file.

```bash
# Linux / macOS: unpack and put `e` on PATH
tar -xzf e-<os>-<arch>.tar.gz
sudo install -m 0755 e /usr/local/bin/e      # or ~/.local/bin, ~/bin, ...
e --version
```

```powershell
# Windows (PowerShell): unpack and put e.exe on PATH
Expand-Archive e-win-x64.zip -DestinationPath "$env:LOCALAPPDATA\Programs\e"
[Environment]::SetEnvironmentVariable("Path", "$env:Path;$env:LOCALAPPDATA\Programs\e", "User")
e --version   # in a new terminal
```

The macOS binaries are ad-hoc signed during the build. If Gatekeeper still
refuses a downloaded copy, clear the quarantine flag once:
`xattr -d com.apple.quarantine ./e`.

### Linux

- **Engine**: [Docker Engine](https://docs.docker.com/engine/install/) with the
  `docker-compose-plugin` (the `get.docker.com` script installs both), or
  Podman 4.4+ with `podman compose` (needs `podman-compose` or
  `docker-compose` installed alongside). Add yourself to the `docker` group so
  `e` can talk to the daemon without `sudo`.
- **Rootless engines** map the container's uid 1000 into your subordinate uid
  range, so the bind-mounted worktree may look owned by an unmapped uid inside
  the container. Verify writability once per machine, see
  [docs/security/attack-surface.md](./docs/security/attack-surface.md) (Zone 1)
  for the probe command and the `--userns=keep-id` workaround.
- **GPU** for the local llama.cpp service: NVIDIA needs the
  `nvidia-container-toolkit`, AMD needs ROCm (`/dev/kfd`), Intel needs
  `/dev/dri`; `e init` detects the vendor and renders the matching image and
  device passthrough.
- Any distribution works; `e` has no distro-specific dependency beyond the
  engine. (Docker's own `sbx` microVM sandboxes are a different product with a
  KVM requirement; `e` does not use them, see issue #107.)

### macOS

Every engine on macOS runs Linux containers inside a VM, and only the paths it
shares with that VM can be bind-mounted. `e` therefore keeps run worktrees
under `~/Library/Caches/e/worktrees`, a path every engine below shares by
default (see [Platform notes](#platform-notes) to move it).

- **Engine**, pick one (all Apple Silicon and Intel):
  - [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) -
    `brew install --cask docker`
  - [OrbStack](https://orbstack.dev/) - `brew install orbstack` (Docker CLI)
  - [Colima](https://github.com/abiosoft/colima) -
    `brew install colima docker docker-compose && colima start` (Docker CLI)
  - [Rancher Desktop](https://rancherdesktop.io/) - `brew install --cask rancher`
    (choose dockerd/moby for `docker`, or containerd for `nerdctl`)
  - [Podman](https://podman.io/) -
    `brew install podman podman-compose && podman machine init && podman machine start`
  - [Finch](https://runfinch.com/) - `brew install --cask finch && finch vm init`
- **Host tools**: `brew install git gh` (or `glab` for GitLab).
- **GPU**: no macOS engine passes a GPU into a container; the local llama.cpp
  service runs on the CPU. Point an Agent at a hosted provider, or at
  Ollama/llama.cpp running natively on the host, for Metal acceleration.

### Windows

The simplest path is **WSL 2**: install a distribution, install Docker Desktop
with the WSL 2 backend (or Docker Engine inside the distribution), and run the
Linux `e` binary from the WSL shell following the Linux notes above.

Running the native `e.exe` from PowerShell or Windows Terminal also works:

- **Engine**, pick one:
  - [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)
    with the WSL 2 backend - `winget install Docker.DockerDesktop`
  - [Podman Desktop](https://podman-desktop.io/) -
    `winget install RedHat.Podman RedHat.Podman-Desktop`, then create a
    Podman machine
  - [Rancher Desktop](https://rancherdesktop.io/) -
    `winget install SUSE.RancherDesktop`
  - [Finch](https://runfinch.com/) - the MSI installer from the
    [Finch releases](https://github.com/runfinch/finch/releases) (needs WSL 2)
- **Host tools**: `winget install Git.Git GitHub.cli` (or `glab`). Git for
  Windows is what `e` calls for worktrees, commits, and pushes.
- **Paths**: run worktrees live under `%LOCALAPPDATA%\e\worktrees`, on the
  system drive every engine shares into its VM. Keep the repository you spawn
  from on a local NTFS drive (a network share or a path only visible inside
  WSL cannot be bind-mounted by a Windows engine).
- **Shell completion**: `e init` writes the completion loader into your
  PowerShell `$PROFILE` when you pick `powershell`; the POSIX shells are
  covered when you run `e` from WSL.
- **GPU**: Docker Desktop's WSL 2 backend passes NVIDIA GPUs through, and
  `e init` renders the CUDA llama.cpp image when `nvidia-smi` is present.
  AMD and Intel GPUs fall back to the CPU image.

### Container runtimes

`e` drives any engine whose CLI matches Docker's (`run`, `build`, `network`,
`volume`, `exec`, `inspect`, `compose`). The `--runtime` names, in
auto-detection order:

| `--runtime` | Executable | Products that provide it                                                   | Local stack (`compose`)           |
| ----------- | ---------- | -------------------------------------------------------------------------- | --------------------------------- |
| `docker`    | `docker`   | Docker Engine, Docker Desktop, OrbStack, Colima, Rancher Desktop (dockerd) | supported                         |
| `podman`    | `podman`   | Podman, Podman Desktop                                                     | supported (`podman compose` 4.4+) |
| `nerdctl`   | `nerdctl`  | containerd hosts: Rancher Desktop (containerd mode), Lima                  | best effort (`nerdctl compose`)   |
| `finch`     | `finch`    | Finch on macOS and Windows                                                 | best effort (`finch compose`)     |

Selection order: `e spawn --runtime <name>`, then the `E_RUNTIME` environment
variable, then the first executable found on `PATH` in the order above.
`e export`/`e import` and `e ollama download` use the same resolution, so a
Podman-only host never sees a stray `docker` call.

The local stack (`.e/compose.yaml`) relies on Compose v2 features - shared
network namespaces (`network_mode: "service:egress"`), healthchecks, and
`--env-file` interpolation - that Docker Compose and `podman compose` honour;
nerdctl's and Finch's Compose implementations are less complete, so with those
runtimes prefer runs without the local stack (skip the runtime selection in
`e init`) and point Agents at a hosted provider.

Not supported as runtimes: Apple's `container` CLI (a different command
surface, no shared network namespaces) and Docker Sandboxes (`sbx`, microVMs
with their own network and image model). Both would need a dedicated adapter
behind the `ContainerRunner` port rather than a registry entry.

### Platform notes

| Concern                          | Linux                                                                                                                             | macOS                                                                                                                        | Windows                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Run worktrees (`/workspace`)     | `$TMPDIR/e-worktrees` (usually `/tmp/e-worktrees`)                                                                                | `~/Library/Caches/e/worktrees`                                                                                               | `%LOCALAPPDATA%\e\worktrees`                                                              |
| Override                         | `E_WORKTREES_DIR=<path>` on every platform; the path must be one the engine can bind-mount (shared into its VM on macOS/Windows)  |                                                                                                                              |                                                                                           |
| Engine socket (browser terminal) | `DOCKER_HOST`/`CONTAINER_HOST`, `/var/run/docker.sock`, `$XDG_RUNTIME_DIR/{docker,podman/podman}.sock`, `/run/podman/podman.sock` | `~/.docker/run/docker.sock`, `/var/run/docker.sock`, OrbStack, Colima, Rancher Desktop, and Podman machine sockets under `~` | `\\.\pipe\docker_engine`, `\\.\pipe\podman-machine-default`, or `DOCKER_HOST=npipe://...` |
| GPU for local llama.cpp          | NVIDIA, AMD (ROCm), Intel (`/dev/dri`)                                                                                            | CPU only                                                                                                                     | NVIDIA via Docker Desktop's WSL 2 backend; otherwise CPU                                  |
| Shell completion via `e init`    | bash, zsh, fish                                                                                                                   | bash, zsh, fish                                                                                                              | PowerShell `$PROFILE` (bash/zsh/fish from WSL)                                            |

## Repo layout

Single-package repo - no npm workspaces. Everything the `e` binary needs lives
at the root:

- `src/` - the Node CLI (`e` commands: init, spawn, serve).
- `ui/` - the React front-end (webpack entry). Its build output is
  `dist/ui`, which `e serve` reads and `pkg.assets` embeds in each standalone
  binary.
- `scripts/` - build preflight helpers (e.g. the `prebuild:bin` UI-assets gate).
- `docs/` - ADRs, security analysis, research notes.

## Build

From the repo root:

```bash
npm install
npm run build:ts   # compiles to dist
```

Run the compiled CLI directly. A convenient alias for a shell session (from the
repo root):

```bash
alias e="node $(pwd)/dist/index.js"
```

```powershell
function e { node "$PWD\dist\index.js" @args }
```

`npm run build` builds the UI, compiles the TypeScript, and packages native
binaries under `command/` via pkg. The UI assets are embedded in each
standalone binary.

The UI lives in the repo root (`ui/`, a React app) and webpack builds it
straight into `dist/ui` - the directory `e serve` reads and pkg embeds. The
`prebuild:bin` gate fails fast if `dist/ui` is missing, so a packaged binary
can never ship without its UI:

```bash
npm run build:ui     # webpack -> dist/ui
npm run build        # UI + TS + pkg binaries
```

For local development, `npm run link` builds everything except the pkg binaries
and installs the CLI globally via `npm link`, putting `e` on your PATH:

```bash
npm run link
e --version
```

Serve the bundled UI locally (pick the binary for your platform:
`e-linux-x64`, `e-linux-arm64`, `e-macos-x64`, `e-macos-arm64`,
`e-win-x64.exe`, or `e-win-arm64.exe`):

```bash
npm run build
command/e-linux-x64 serve
```

The server binds to `127.0.0.1:8080` by default. Use `--host` and `--port` to
change the bind address, or `--detached` to run it in the background. Stop a
detached server with `e serve stop`. It serves the UI at `/` and provides
`/api/health` and `/api/info`.

The UI's Terminal page starts runs from the browser (ADR-0014): pick an agent,
optionally name the run, and the harness's TUI opens in the page. Each session
is a headless `e spawn <agent> --name <slug>` in the directory `e serve` was
started in, so start `e serve` inside the repository you want to work on. The
terminal attaches to the run container through the container engine's socket:
`DOCKER_HOST` (`unix://…` or `npipe://…`) or Podman's `CONTAINER_HOST` when
set, otherwise the platform's usual sockets - `/var/run/docker.sock` and the
rootless Docker/Podman user sockets on Linux, the Docker Desktop, OrbStack,
Colima, Rancher Desktop, and Podman machine sockets under `~` on macOS, and
the `docker_engine`/`podman-machine-default` named pipes on Windows (see
[Platform notes](#platform-notes)). Without one the page explains that runs
cannot be started.

## Test

Three levels, cheapest first.

### 1. Unit tests

```bash
npm test
```

Builds and runs the full `node --test` suite (adapters, delivery planning,
harness registry, spawn planning, store, …). `npm run test:ui-assets` runs the
UI-assets guard tests (the `prebuild:bin` gate) separately:

### 2. Rendering checks (no container, no gateway)

Exercise the pure rendering directly against the compiled modules - the fastest
way to _see_ what a harness will receive. Run from the repo root:

```bash
# The pi models.json a provider renders. pi selects only models declared here, so
# e resolves the API key by name from the store and writes its VALUE into the file
# (which is then baked into the derived image - see the credential note below):
node -e "const a=require('./dist/harness/adapter');console.log(a.renderPiModelsJson({baseUrl:'https://gw.example.com/v1',model:'claude-opus-5',protocol:'anthropic-messages',apiKeyEnv:'MY_GATEWAY_KEY'},{MY_GATEWAY_KEY:'sk-secret'}))"

# Protocol → pi api mapping (only openai-chat's name differs from e's):
node -e "const a=require('./dist/harness/adapter');console.log(a.piApi('openai-chat'), a.piApi('anthropic-messages'))"
# → openai-completions anthropic-messages

# The container argv pi runs when a provider/model is delivered (argv, no
# shell: the prompt is one element and needs no quoting):
node -e "const {HARNESSES}=require('./dist/harness/index');console.log(HARNESSES.pi.buildCommand('fix the bug','claude-opus-5'))"
# → [ 'pi', '-p', 'fix the bug', '--provider', 'e', '--model', 'claude-opus-5' ]

# pi gets MCP through the pi-mcp-adapter package e installs in its image,
# delivered as a rendered file; opencode has no MCP delivery yet, so --mcp is
# gated off there:
node -e "const {HARNESSES,harnessCapabilities}=require('./dist/harness/index');console.log(harnessCapabilities(HARNESSES.pi).mcp, harnessCapabilities(HARNESSES.opencode).mcp)"
# → file none
```

### 3. End-to-end run

Requires: a container engine on `PATH` (`docker`, `podman`, `nerdctl`, or
`finch`, see [Container runtimes](#container-runtimes)), a **git repo** to run
inside (each run cuts its own worktree and branch), and a reachable model
endpoint + key.

**a. Initialize the store** (writes `~/.e/` - Dockerfiles, default agents,
`.env`, `config.json`). Interactive; press Enter to accept `pi` as the favorite,
and fill in keys or skip and edit `.e/.env` later:

```bash
e init
```

**b. Put the provider's API key in `~/.e/.env`.** A custom provider references
its key by the env-var _name_ you choose (`apiKeyEnv` below); the value lives
only here. Claude Code and Codex inject it at runtime by name, never baking it.
**pi is the exception:** because it selects only models declared in `models.json`,
`e` resolves the key by name and writes its _value_ into that file, which is then
baked into the pi derived image (see step e).

```bash
echo 'MY_GATEWAY_KEY=sk-...' >> ~/.e/.env
```

**c. Define a pi agent with a provider** at `~/.e/agents/pi-gw/agent.json`:

```json
{
  "name": "pi-gw",
  "harness": "pi",
  "provider": {
    "baseUrl": "https://your-gateway.example.com",
    "model": "claude-sonnet-4-5",
    "protocol": "anthropic-messages",
    "apiKeyEnv": "MY_GATEWAY_KEY"
  }
}
```

`protocol` must be one pi speaks - `anthropic-messages`, `openai-chat`, or
`openai-responses`. Use a concrete `model` for the first run; `"auto/coding"` is
resolved by the harness against the endpoint's `/v1/models` at run start (see
[ADR-0007](./docs/adr/0007-auto-model-delivery.md)).

**d. Spawn it inside any git repo:**

```bash
cd /path/to/some/git/repo
e spawn pi-gw "print hello world in python"
```

First run builds the pi base image (slow - it installs the pi CLI), then a thin
derived image `e-agent-pi-gw` that bakes `models.json`, then runs
`pi -p "<prompt>" --provider e --model claude-sonnet-4-5` in the container. On
success a run branch `e/pi-gw/<slug>-1` is created (and pushed if it produced
commits). If `e init` was asked for a git platform, the push is also opened as a
PR/MR into the branch you were on when you spawned - title is the run branch's
commit message, body is the prompt, and the URL is printed on success.

**e. Inspect the baked config** - proof the provider was delivered:

```bash
cat ~/.e/agents/pi-gw/models.json    # the rendered provider (baked API-key value)
cat ~/.e/agents/pi-gw/Dockerfile      # ENV PI_CODING_AGENT_DIR + COPY models.json
```

**f. Confirm MCP is gated for a harness without MCP delivery** (fast; needs
only the store, not a container; pi itself accepts `--mcp`):

```bash
e spawn opencode --mcp everything "hi"
# → Harness "opencode" has no MCP client, so it cannot use --mcp.
```

> **pi + `auto` model note:** pi selects only models declared in its
> `models.json`, so `e` declares `auto` there and passes it on the command line
> (`--provider e --model auto`); pi resolves `auto` at run start against the
> endpoint's model list. Codex instead carries `-m auto` on the run command with
> a model-agnostic baked config (ADR-0007).

## Skills

Every harness image installs a default set of skill **collections** at build
time, one `RUN npx -y skills@latest add <collection> -a <agent> -g -y --copy`
per collection. The `-a <agent>` flag makes the CLI place them into the
exact skills dir the harness CLI reads (Claude Code `~/.claude/skills`; the
shared `~/.agents/skills` for Codex, opencode, and pi) - outside `/workspace`,
so they never land in a run's branch. `e init` renders these instructions into
each harness Dockerfile from its declared `skillCollections`/`skillsAgent`;
git is installed in the image first so the CLI can clone the source.

Two further layers add skills for a specific agent or run:

| Way                          | What it does                                                    |
| ---------------------------- | --------------------------------------------------------------- |
| Harness image (layer 1)      | Collections installed at build time, available to every run     |
| `agent.json` `skills: ["…"]` | Baked into an agent's derived image (`e-agent-<name>`, layer 2) |
| `e spawn … --skill <name>`   | Mounted read-only for that run (layer 3)                        |

## Merge requests on a successful run

`e init` asks for a **git platform** - `github`, `gitlab`, `forgejo`, or
`gitea` - and records it in `.e/config.json`. On a run that pushes, `e` then
opens a PR/MR automatically:

- **Title**: the run branch's tip commit message.
- **Body**: the prompt that drove the run.
- **Base**: the branch you were on when you spawned (the run's natural target),
  so the agent branch merges back into your `feature/…`/`dev`/`main` branch.
- **Tool**: the platform's native CLI on the host - `gh` (GitHub, and the
  GitHub-compatible Forgejo/Gitea, resolving the host from the git remote) or
  `glab` (GitLab). Needs that CLI installed and authenticated on the host,
  never in the container (ADR-0002).

Blank the platform prompt to disable PR/MR creation; a re-init with `--yes`
keeps the configured platform. PR/MR failure is non-fatal - the pushed branch
is the durable artifact, and a warning reports why the open failed.

## Cheat sheet

| Command                                        | What it does                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `e init`                                       | Write the store (`~/.e`): Dockerfiles, default agents, `.env`, config. Also asks for the git platform (PR/MR on successful runs) |
| `e spawn <agent-or-harness> "<prompt>"`        | Run an agent/harness against a prompt (one-shot detached)                                                                        |
| `e spawn <agent-or-harness>`                   | Start the harness TUI (interactive by default)                                                                                   |
| `e spawn … --skill <name>`                     | Add a Skill for this run                                                                                                         |
| `e spawn … --mcp <name>`                       | Wire an MCP server (rejected for opencode, which has no MCP delivery yet)                                                        |
| `e spawn … --rebuild`                          | Force-rebuild the image (needed after changing a baked provider/model)                                                           |
| `e init --dir <path>` / `e spawn --dir <path>` | Use `<path>/.e` as the store instead of `~/.e`                                                                                   |
| `e spawn … --runtime <name>`                   | Pick the container engine (`docker`, `podman`, `nerdctl`, `finch`); default `$E_RUNTIME`, else the first one on `PATH`           |
| `e spawn` (platform configured)                | Push the run branch, then open a PR/MR into your current branch                                                                  |

## Environment variables

Host-side knobs the `e` process reads (`src/utils/env.ts`); none of them is
injected into a container.

| Variable                         | Effect                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `E_RUNTIME`                      | Container engine to use when `--runtime` is not passed: `docker`, `podman`, `nerdctl`, or `finch`                 |
| `E_WORKTREES_DIR`                | Where run worktrees are created; must be a path the engine can bind-mount (see [Platform notes](#platform-notes)) |
| `DOCKER_HOST` / `CONTAINER_HOST` | Engine socket for the browser terminal (`unix://` or `npipe://`); also honoured by the engine CLIs themselves     |
| `OMNIROUTE_URL`                  | Where `e` reaches the local OmniRoute gateway (default `http://127.0.0.1:20128`)                                  |
| `EGRESS_API_URL`                 | Where `e` reaches the egress blacklist API (default `http://127.0.0.1:20129`)                                     |
| `LOCAL_LLAMA_URL`                | Where `e llamacpp download` reaches llama.cpp (default `http://127.0.0.1:9931`)                                   |
| `VERBOSE=true`                   | Debug logging (same as `-v`)                                                                                      |
| `SHOULD_WRITE_LOG_FILE=true`     | Mirror every log line to `log.txt` in the working directory                                                       |
