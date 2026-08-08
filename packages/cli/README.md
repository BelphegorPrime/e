# `e` — coding-agent harness runner

`e` builds and runs coding-agent harnesses (Claude Code, Codex, opencode, **pi**)
inside containers, one isolated run per git worktree. This README is the
hands-on guide to building it and trying a harness locally. For the concepts
(Harness, Agent, Provider, Sidecar, Run, …) see [CONTEXT.md](./CONTEXT.md); for
the design rationale see [docs/adr/](./docs/adr/).

## Build

From the repo root:

```bash
npm install
npm run build:ts --workspace @monorepo/cli   # compiles to packages/cli/dist
```

Run the compiled CLI directly. A convenient alias for a shell session (from the
repo root):

```bash
alias e="node $(pwd)/packages/cli/dist/index.js"
```

`npm run build` additionally packages native binaries under `command/` via pkg.

## Test

Three levels, cheapest first.

### 1. Unit tests

```bash
npm test --workspace @monorepo/cli
```

Builds and runs the full `node --test` suite (adapters, delivery planning,
harness registry, spawn planning, store, …).

### 2. Rendering checks (no container, no gateway)

Exercise the pure rendering directly against the compiled modules — the fastest
way to *see* what a harness will receive. Run from `packages/cli/`:

```bash
# The pi models.json a provider renders (API key referenced by name, never baked):
node -e "const a=require('./dist/harness/adapter');console.log(a.renderPiModelsJson({baseUrl:'https://gw.example.com/v1',model:'claude-opus-5',protocol:'anthropic-messages',apiKeyEnv:'MY_GATEWAY_KEY'}))"

# Protocol → pi api mapping (two names differ from e's):
node -e "const a=require('./dist/harness/adapter');console.log(a.piApi('openai-chat'), a.piApi('google'))"
# → openai-completions google-generative-ai

# The container argv pi runs when a provider/model is delivered:
node -e "const {HARNESSES}=require('./dist/harness/index');console.log(HARNESSES.pi.buildCommand('fix the bug','claude-opus-5'))"
# → [ 'pi', '-p', 'fix the bug', '--provider', 'e', '--model', 'claude-opus-5' ]

# pi ships no MCP client, so --mcp is gated off:
node -e "const {HARNESSES,mcpDeliveryForm}=require('./dist/harness/index');console.log(mcpDeliveryForm(HARNESSES.pi))"
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
its key by the env-var *name* you choose (`apiKeyEnv` below); the value lives
only here and is injected at runtime, never baked into an image:

```bash
echo 'MY_GATEWAY_KEY=sk-...' >> ~/.e/.env
```

**c. Define a pi agent with a provider** at `~/.e/agents/pi-gw/agent.json`:

```json
{
  "name": "pi-gw",
  "harness": "pi",
  "tier": "default",
  "provider": {
    "baseUrl": "https://your-gateway.example.com",
    "model": "claude-sonnet-4-5",
    "protocol": "anthropic-messages",
    "apiKeyEnv": "MY_GATEWAY_KEY"
  }
}
```

`protocol` must be one pi speaks — `anthropic-messages`, `openai-chat`,
`openai-responses`, or `google`. Use a concrete `model` for the first run;
`"auto"` (with a non-`default` tier) resolves the best model from the endpoint's
`/v1/models` at spawn (see
[ADR-0007](./docs/adr/0007-tiers-and-auto-model-resolution.md)).

**d. Spawn it inside any git repo:**

```bash
cd /path/to/some/git/repo
e spawn pi-gw "print hello world in python"
```

First run builds the pi base image (slow — it installs the pi CLI), then a thin
derived image `e-agent-pi-gw` that bakes `models.json`, then runs
`pi -p "<prompt>" --provider e --model claude-sonnet-4-5` in the container. On
success a run branch `e/pi-gw/<slug>-1` is created (and pushed if it produced
commits).

**e. Inspect the baked config** — proof the provider was delivered:

```bash
cat ~/.e/agents/pi-gw/models.json    # the rendered provider (key by ${NAME})
cat ~/.e/agents/pi-gw/Dockerfile     # ENV PI_CODING_AGENT_DIR + COPY models.json
```

**f. Confirm MCP is gated** (fast; needs only the store, not a container):

```bash
e spawn pi-gw --mcp everything "hi"
# → Harness "pi" has no MCP client, so it cannot use --mcp.
```

> **pi + `auto` model gotcha:** pi selects only models declared in
> `models.json`, so an `auto`-resolved model is **baked** into the derived image
> (unlike Codex, which passes it on the command line). A newly-shipped model is
> not picked up until you rebuild: `e spawn pi-gw --rebuild "…"`. This trade-off
> is recorded in [ADR-0007](./docs/adr/0007-tiers-and-auto-model-resolution.md).

## Cheat sheet

| Command | What it does |
|---|---|
| `e init` | Write the store (`~/.e`): Dockerfiles, default agents, `.env`, config |
| `e spawn <agent-or-harness> "<prompt>"` | Run an agent/harness against a prompt |
| `e spawn <harness> --tier <tier> "…"` | Select a harness's agent by tier |
| `e spawn … --skill <name>` | Add a Skill for this run |
| `e spawn … --mcp <name>` | Wire an MCP server (rejected for pi) |
| `e spawn … --rebuild` | Force-rebuild the image (needed after changing a baked provider/model) |
| `e init --dir <path>` / `e spawn --dir <path>` | Use `<path>/.e` as the store instead of `~/.e` |
</content>
