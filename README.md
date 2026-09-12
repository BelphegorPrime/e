# `e` - coding-agent harness runner

`e` builds and runs coding-agent harnesses (Claude Code, Codex, opencode, **pi**)
inside containers, one isolated run per git worktree. This README is the
hands-on guide to building it and trying a harness locally. For the concepts
(Harness, Agent, Provider, Sidecar, Run, …) see [CONTEXT.md](./CONTEXT.md); for
the design rationale see [docs/adr/](./docs/adr/); for the agent-facing guide
to delegating work with `e` and `e spawn` see
[docs/agents/e.md](./docs/agents/e.md). New here? Start with the step-by-step
[Tutorials](#tutorials). Jump to [Usage examples](#usage-examples)
for everyday commands, or to [Working on this repository](#working-on-this-repository)
if you are here to change `e` itself.

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

## Tutorials

Hands-on walkthroughs in [docs/tutorials/](./docs/tutorials/), each ending
with something you can inspect. Read them in order the first time:

1. [Your first run](./docs/tutorials/01-first-run.md) - install, `e init`, one Agent on a hosted key, a run branch to diff.
2. [Agents for every Harness on a hosted Provider](./docs/tutorials/02-hosted-provider.md) - pi, Claude Code, and Codex on one gateway; protocols, delivery, `--rebuild`.
3. [Run agents on local models](./docs/tutorials/03-local-models.md) - the OmniRoute stack with llama.cpp or Ollama, model downloads, the default Agents.
4. [Give an agent a Skill](./docs/tutorials/04-skills.md) - write a Skill, add it per run, bake it into an Agent.
5. [Wire an MCP server into a run](./docs/tutorials/05-mcp-servers.md) - container Sidecars and remote servers with a token.
6. [Let an agent fan out into sibling runs](./docs/tutorials/06-sibling-runs.md) - `spawn-brother`, the broker, merge-back, reports.
7. [The web UI, browser terminal, and `e` as an A2A agent](./docs/tutorials/07-serve-and-a2a.md) - `e serve`, runs from the browser, Agent2Agent tasks, remote agents.
8. [Watch and block what agents talk to](./docs/tutorials/08-egress-blacklist.md) - the egress log and DNS blacklist API.
9. [Several Stores, and moving one](./docs/tutorials/09-stores-export-import.md) - per-project Stores, `e export` / `e import`.

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
- `docs/` - ADRs, security analysis, research notes, tutorials.

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

Four levels, cheapest first.

### 1. Unit tests

```bash
npm test
```

Builds and runs the full `node --test` suite (adapters, delivery planning,
harness registry, spawn planning, store, …). `npm run test:ui-assets` runs the
tests of the build scripts (the `prebuild:bin` gate, the UI smoke test's
helpers) separately.

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

### 3. UI smoke test (headless Chrome, no container)

```bash
npm run build:dev && npm run smoke:ui
```

Drives the built web UI through the Chrome or Chromium already on the machine
(no download; `$CHROME_PATH` or `--chrome <path>` if it is not on `PATH`).
Every page is rendered in light, dark and a phone-width viewport against a
deterministic fixture BFF (fake git refs, agents, egress data, terminal
options - no Store, engine or git state needed), then the theme toggle,
sidebar collapse, mobile sheet and terminal Advanced section are exercised.
The run fails on console or page errors, failed or 4xx/5xx requests, a broken
layout (sidebar width, content under the sidebar, palette, fonts), and - once
`--update-baseline` has recorded one - a pixel diff above `--max-diff`
(default 0.5%). Screenshots, diff images and `report.json` land in
`ui/.smoke/` (gitignored). `--url http://127.0.0.1:8080` targets a live
`e serve` instead of the fixture. Typical before/after check of a UI change:

```bash
npm run smoke:ui -- --update-baseline   # on the old code
npm run build:ui && npm run smoke:ui    # on the new code: diffs in ui/.smoke/diff/
```

### 4. End-to-end run

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

## Usage examples

Everyday flows, all from inside the git repository you want the agent to work
on (each run cuts its own worktree and branch; nothing touches your checkout).

```bash
# One-shot task with the favorite harness's default agent (pi after `e init`):
e spawn pi "Add input validation to src/api/users.ts and cover it with tests"

# The same with a named agent from ~/.e/agents/<name>/agent.json:
e spawn smart-claude "Refactor the payment module; keep the public API stable"

# Interactive: open the harness TUI in the container instead of a one-shot prompt
e spawn pi

# Give the run extra capabilities: a Skill from .e/skills, an MCP sidecar from .e/mcp
e spawn pi --skill review-checklist --mcp everything "Review the open PRs' diffs"

# Keep the worktree after the run to inspect it (it lives under the worktrees
# dir, see Platform notes; the branch e/<agent>/<slug>-N exists either way)
e spawn pi --keep-worktree "Try upgrading to express 5 and note what breaks"

# Pass a secret or setting only this run needs (never written into an image)
e spawn codex --env-file ./ci.env -e FEATURE_FLAG=on "Run the migration dry-run"

# Pick the engine explicitly, or use another store than ~/.e
e spawn pi --runtime podman "Fix the flaky test"
e init --dir ./infra && e spawn pi --dir ./infra "Bump the base images"

# Force an image rebuild after editing an agent's provider/model or a Dockerfile
e spawn smart-claude --rebuild "hello"

# Browser UI + terminal: start it in the repo you want runs to happen in
e serve --detached && open http://127.0.0.1:8080   # `e serve stop` ends it

# Move a configured store (agents, gateway config) to another machine
e export -o e-state.zip && e import e-state.zip
```

What you get back: a branch `e/<agent>/<slug>-N` with the agent's commits (its
leftover changes are committed as `e: run output for <branch>`), pushed to
`origin` when the run exited 0 and produced commits, and a PR/MR into the
branch you spawned from when `e init` was given a git platform.

### Letting an agent fan out (sibling runs)

A run that carries the `spawn-brother` skill gets a runtime-broker sidecar,
and the agent inside can ask for **sibling** runs that work in parallel and
are merged back into its worktree by the host (ADR-0013):

```bash
e spawn pi --skill spawn-brother "Split the API migration by module and delegate each module to a brother; integrate the results"
```

Inside the container the agent runs the skill's script; you see the same
lifecycle on the host as `Sibling sib-001 (...)` log lines and one summary line
per sibling at the end (`merge-back merged`, `conflict`, `held`, ...). The
sibling branches stay in the repo for inspection (`git branch --list 'e/*'`);
their work reaches you through the parent's branch, where each is one merge
commit, plus a report per sibling under `e-runs/<id>/report.md`.

Every sibling record also carries `taskState`, the lifecycle in the
Agent2Agent (A2A) vocabulary (`submitted`, `working`, `input-required`,
`completed`, `canceled`, `failed`, `rejected`, ADR-0015); the agent can block
on it with `--watch` instead of polling, and cancel a sibling with `--cancel`.

### `e` as an A2A agent

`e serve` publishes an [Agent2Agent](https://a2a-protocol.org) agent card at
`/.well-known/agent-card.json` and speaks the A2A 1.0 JSON-RPC binding on
`POST /a2a` (ADR-0015; verified against the official `@a2a-js/sdk` in both
directions, `src/a2a/interop.test.ts`). Every harness agent in the Store is one skill; a task
is one run whose artifact is the branch, whether it was pushed, and the PR/MR
URL. Any A2A client (an orchestrator, another agent) can therefore hand `e` a
task:

```bash
e serve --detached
curl -s http://127.0.0.1:8080/.well-known/agent-card.json | jq .skills[].id
curl -s http://127.0.0.1:8080/a2a -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "SendMessage",
  "params": { "message": { "messageId": "m1", "role": "ROLE_USER",
    "parts": [{ "text": "Add input validation to src/api/users.ts and cover it with tests" }],
    "metadata": { "agent": "pi" } } } }'
# -> {"result":{"task":{"id":"...","status":{"state":"TASK_STATE_SUBMITTED"},...}}}
# then GetTask (or SendStreamingMessage for server-sent events) until TASK_STATE_COMPLETED
```

The endpoint is open on loopback, like the rest of `serve`. Set `E_A2A_TOKEN`
to require `Authorization: Bearer <token>`; bound beyond loopback (`--host`)
without a token the endpoint stays off. Tasks take no follow-up messages: put
the whole task into the first one.

### Remote A2A agents in the Store

An `agent.json` with `"transport": "a2a"` names an agent hosted elsewhere that
speaks A2A. It is selected by name like any agent, but has no harness and no
worktree: `e` sends it the prompt and prints (or, as a sibling, reports) its
answer.

```jsonc
// ~/.e/agents/remote-researcher/agent.json
{
  "name": "remote-researcher",
  "transport": "a2a",
  "url": "https://agents.example.com/a2a",
  "headers": { "Authorization": "Bearer ${RESEARCH_TOKEN}" },
  "requiredEnv": ["RESEARCH_TOKEN"],
  "description": "Answers research questions from the company wiki",
}
```

```bash
e spawn remote-researcher "Which teams own the payment service?"   # the answer on stdout, no branch
node $S remote-researcher "Summarize the ADRs on git handling"     # as a sibling: answer in e-runs/<id>/report.md
```

`${VAR}` references in `headers` resolve from `.e/.env` on the host at call
time; the value never enters a container or an image.

## Working on this repository

For contributors and for AI agents asked to change `e` itself. Read, in this
order: [AGENTS.md](./AGENTS.md) (house rules), [CONTEXT.md](./CONTEXT.md) (the
vocabulary - use these terms in code, comments, and docs), the
[ADRs](./docs/adr/) behind the area you touch, and
[docs/tickets/](./docs/tickets/) for the planning write-ups of larger
features. Work items are GitHub issues in `BelphegorPrime/e`
([docs/agents/issue-tracker.md](./docs/agents/issue-tracker.md)).

The loop:

```bash
npm install
npm run build:ts                      # bundles the container programs, then tsc -> dist/
npm test                              # build + the whole node:test suite (~770 tests)
node --test dist/runs/runSpawn.test.js dist/git/host.test.js   # one or two files while iterating
npm run lint && npx prettier --check .                          # what CI and the pre-commit hook check
alias e="node $(pwd)/dist/index.js"   # try the CLI you just built
```

Rules that bite:

- **Tests follow code.** Every behaviour change ships with the test that would
  have caught it, in the `*.test.ts` next to the module (`node:test`, no other
  runner). Real-git and real-broker tests exist (`src/git/host.test.ts`,
  `src/runs/runSpawn.e2e.test.ts`); prefer them over fakes for anything that
  touches git or the spool. Do not run the suite with `--test-force-exit`; it
  silently drops tests.
- **Ports, not shell-outs.** Git and the container engine are reached only
  through the `Git` and `ContainerRunner` interfaces (`src/git/index.ts`,
  `src/runtime/index.ts`), so every orchestrator test can drive a fake.
  Container-shipped code (`src/broker/*`, `src/egress/*`) is real TypeScript
  bundled by esbuild (`bundle.generated.ts` is generated, never edited) and may
  import Node built-ins only.
- **Host owns git and secrets** (ADR-0002): nothing under `src/` may hand a
  container a git credential, a docker socket, or `.env` contents beyond the
  keys a run declares.
- **Docs move with the code**: a shipped ticket gets a status paragraph at its
  top and a row in `docs/tickets/README.md`; a new term or changed contract
  lands in `CONTEXT.md`; an amendment to a decision goes into its ADR rather
  than a new file.
- Plain ASCII hyphens in prose (no long dashes); responses in caveman mode per
  AGENTS.md.

### If you are an agent inside an `e` run of this repo

You are in `/workspace`, a disposable worktree on `e/<agent>/<slug>-N`. Do not
run `git add`/`commit`/`push`/`worktree`; `e` captures your changes when you
exit 0. Your role is `$E_ROLE`; `$E_BROKER_URL` names the runtime-broker if
this run has one. Delegate with the `spawn-brother` skill when the task splits:

```bash
S=~/.agents/skills/spawn-brother/spawn-brother.mjs     # ~/.claude/skills/... under Claude Code
node $S researcher "Read docs/adr/0013-*.md and CONTEXT.md; list every place the merge-back vocabulary is out of date. Write findings to notes/mergeback-audit.md."
node $S --status                 # requested -> starting -> running -> done | failed | canceled | rejected
node $S --status sib-001         # one sibling; `merge` and `report` appear once it exited; `taskState` is the A2A view
node $S --watch                  # block until a sibling's taskState needs you (input-required, completed, failed, ...)
cat e-runs/sib-001/report.md     # what the host did with its branch and what you must do
node $S --merge sib-001          # after resolving `merge.status: conflict` markers or clearing `held` files
node $S --cancel sib-002         # stop a sibling you no longer need
```

The host checkpoints your uncommitted work before a sibling starts and again
before its branch is merged back; a sibling's files appear in `/workspace` in
place. Never resolve a merge with git yourself - edit the marked files, then
signal. If the broker does not answer, write the follow-up task down as a file
and exit 0 ([docs/agents/e.md](./docs/agents/e.md), Recursive spawning).

## Cheat sheet

| Command                                        | What it does                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `e init`                                       | Write the store (`~/.e`): Dockerfiles, default agents, `.env`, config. Also asks for the git platform (PR/MR on successful runs) |
| `e spawn <agent-or-harness> "<prompt>"`        | Run an agent/harness against a prompt (one-shot)                                                                                 |
| `e spawn <agent-or-harness>`                   | Start the harness TUI (no prompt means interactive)                                                                              |
| `e spawn … --skill <name>`                     | Add a Skill for this run                                                                                                         |
| `e spawn … --mcp <name>`                       | Wire an MCP server (rejected for opencode, which has no MCP delivery yet)                                                        |
| `e spawn … --rebuild`                          | Force-rebuild the image (needed after changing a baked provider/model)                                                           |
| `e init --dir <path>` / `e spawn --dir <path>` | Use `<path>/.e` as the store instead of `~/.e`                                                                                   |
| `e spawn … --runtime <name>`                   | Pick the container engine (`docker`, `podman`, `nerdctl`, `finch`); default `$E_RUNTIME`, else the first one on `PATH`           |
| `e spawn` (platform configured)                | Push the run branch, then open a PR/MR into your current branch                                                                  |
| `e spawn … --keep-worktree`                    | Leave the run's worktree in place for inspection                                                                                 |
| `e spawn … --skill spawn-brother`              | Let the agent request sibling runs; the host merges each back into its worktree (ADR-0013)                                       |
| `e spawn <remote-agent> "<prompt>"`            | Ask a Store agent with `"transport": "a2a"` over the Agent2Agent protocol; the answer on stdout, no run (ADR-0015)               |
| `e serve [--detached]` / `e serve stop`        | Web UI, browser terminal, and the A2A endpoint (`/.well-known/agent-card.json`, `POST /a2a`); stop the background server         |
| `e export` / `e import <file>`                 | Move the store and gateway configuration between machines as a zip                                                               |

## Environment variables

Host-side knobs the `e` process reads (`src/utils/env.ts`); none of them is
injected into a container.

| Variable                         | Effect                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `E_RUNTIME`                      | Container engine to use when `--runtime` is not passed: `docker`, `podman`, `nerdctl`, or `finch`                 |
| `E_WORKTREES_DIR`                | Where run worktrees are created; must be a path the engine can bind-mount (see [Platform notes](#platform-notes)) |
| `DOCKER_HOST` / `CONTAINER_HOST` | Engine socket for the browser terminal (`unix://` or `npipe://`); also honoured by the engine CLIs themselves     |
| `E_A2A_TOKEN`                    | Bearer token `e serve` requires on its A2A endpoint; required to expose it beyond loopback (ADR-0015)             |
| `OMNIROUTE_URL`                  | Where `e` reaches the local OmniRoute gateway (default `http://127.0.0.1:20128`)                                  |
| `EGRESS_API_URL`                 | Where `e` reaches the egress blacklist API (default `http://127.0.0.1:20129`)                                     |
| `LOCAL_LLAMA_URL`                | Where `e llamacpp download` reaches llama.cpp (default `http://127.0.0.1:9931`)                                   |
| `VERBOSE=true`                   | Debug logging (same as `-v`)                                                                                      |
| `SHOULD_WRITE_LOG_FILE=true`     | Mirror every log line to `log.txt` in the working directory                                                       |
