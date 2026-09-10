# `e` — coding-agent harness runner

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

## Repo layout

Single-package repo — no npm workspaces. Everything the `e` binary needs lives
at the root:

- `src/` — the Node CLI (`e` commands: init, spawn, serve).
- `ui/` — the React front-end (webpack entry). Its build output is
  `dist/ui`, which `e serve` reads and `pkg.assets` embeds in each standalone
  binary.
- `scripts/` — build preflight helpers (e.g. the `prebuild:bin` UI-assets gate).
- `docs/` — ADRs, security analysis, research notes.

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

Serve the bundled UI locally:

```bash
npm run build
command/e-linux-x64 serve
```

The server binds to `127.0.0.1:8080` by default. Use `--host` and `--port` to
change the bind address, or `--detached` to run it in the background. Stop a
detached server with `e serve stop`. It serves the UI at `/` and provides
`/api/health` and `/api/info`.

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

Exercise the pure rendering directly against the compiled modules — the fastest
way to _see_ what a harness will receive. Run from the repo root:

```bash
# The pi models.json a provider renders. pi selects only models declared here, so
# e resolves the API key by name from the store and writes its VALUE into the file
# (which is then baked into the derived image — see the credential note below):
node -e "const a=require('./dist/harness/adapter');console.log(a.renderPiModelsJson({storeEnv:{MY_GATEWAY_KEY:'sk-secret'}},{baseUrl:'https://gw.example.com/v1',model:'claude-opus-5',protocol:'anthropic-messages',apiKeyEnv:'MY_GATEWAY_KEY'}))"

# Protocol → pi api mapping (only openai-chat's name differs from e's):
node -e "const a=require('./dist/harness/adapter');console.log(a.piApi('openai-chat'), a.piApi('anthropic-messages'))"
# → openai-completions anthropic-messages

# The container argv pi runs when a provider/model is delivered (the prompt is
# rendered quoted):
node -e "const {HARNESSES}=require('./dist/harness/index');console.log(HARNESSES.pi.buildCommand('fix the bug','claude-opus-5'))"
# → [ 'pi', '-p', '"fix the bug"', '--provider', 'e', '--model', 'claude-opus-5' ]

# pi ships no MCP client, so --mcp is gated off:
node -e "const {HARNESSES,harnessCapabilities}=require('./dist/harness/index');console.log(harnessCapabilities(HARNESSES.pi).mcp)"
# → none
```

### 3. End-to-end run

Requires: `docker` **or** `podman` on `PATH`, a **git repo** to run inside (each
run cuts its own worktree and branch), and a reachable model endpoint + key.

**a. Initialize the store** (writes `~/.e/` — Dockerfiles, default agents,
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

`protocol` must be one pi speaks — `anthropic-messages`, `openai-chat`, or
`openai-responses`. Use a concrete `model` for the first run; `"auto/coding"` is
resolved by the harness against the endpoint's `/v1/models` at run start (see
[ADR-0007](./docs/adr/0007-auto-model-delivery.md)).

**d. Spawn it inside any git repo:**

```bash
cd /path/to/some/git/repo
e spawn pi-gw "print hello world in python"
```

First run builds the pi base image (slow — it installs the pi CLI), then a thin
derived image `e-agent-pi-gw` that bakes `models.json`, then runs
`pi -p "<prompt>" --provider e --model claude-sonnet-4-5` in the container. On
success a run branch `e/pi-gw/<slug>-1` is created (and pushed if it produced
commits). If `e init` was asked for a git platform, the push is also opened as a
PR/MR into the branch you were on when you spawned — title is the run branch's
commit message, body is the prompt, and the URL is printed on success.

**e. Inspect the baked config** — proof the provider was delivered:

```bash
cat ~/.e/agents/pi-gw/models.json    # the rendered provider (baked API-key value)
cat ~/.e/agents/pi-gw/Dockerfile      # ENV PI_CODING_AGENT_DIR + COPY models.json
```

**f. Confirm MCP is gated** (fast; needs only the store, not a container):

```bash
e spawn pi-gw --mcp everything "hi"
# → Harness "pi" has no MCP client, so it cannot use --mcp.
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
shared `~/.agents/skills` for Codex, opencode, and pi) — outside `/workspace`,
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

`e init` asks for a **git platform** — `github`, `gitlab`, `forgejo`, or
`gitea` — and records it in `.e/config.json`. On a run that pushes, `e` then
opens a PR/MR automatically:

- **Title**: the run branch's tip commit message.
- **Body**: the prompt that drove the run.
- **Base**: the branch you were on when you spawned (the run's natural target),
  so the agent branch merges back into your `feature/…`/`dev`/`main` branch.
- **Tool**: the platform's native CLI on the host — `gh` (GitHub, and the
  GitHub-compatible Forgejo/Gitea, resolving the host from the git remote) or
  `glab` (GitLab). Needs that CLI installed and authenticated on the host,
  never in the container (ADR-0002).

Blank the platform prompt to disable PR/MR creation; a re-init with `--yes`
keeps the configured platform. PR/MR failure is non-fatal — the pushed branch
is the durable artifact, and a warning reports why the open failed.

## Cheat sheet

| Command                                        | What it does                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `e init`                                       | Write the store (`~/.e`): Dockerfiles, default agents, `.env`, config. Also asks for the git platform (PR/MR on successful runs) |
| `e spawn <agent-or-harness> "<prompt>"`        | Run an agent/harness against a prompt (one-shot detached)                                                                        |
| `e spawn <agent-or-harness>`                   | Start the harness TUI (interactive by default)                                                                                   |
| `e spawn … --skill <name>`                     | Add a Skill for this run                                                                                                         |
| `e spawn … --mcp <name>`                       | Wire an MCP server (rejected for pi)                                                                                             |
| `e spawn … --rebuild`                          | Force-rebuild the image (needed after changing a baked provider/model)                                                           |
| `e init --dir <path>` / `e spawn --dir <path>` | Use `<path>/.e` as the store instead of `~/.e`                                                                                   |
| `e spawn` (platform configured)                | Push the run branch, then open a PR/MR into your current branch                                                                  |
