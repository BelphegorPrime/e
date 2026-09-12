# Using `e` as a spawned agent

Read this when you are an AI agent working inside a project that `e` spawned
(or a project that uses `e`). It answers the questions you need to decide
_whether_ to delegate work to other agents and _how_.

## What `pi` is

`pi` is a coding-agent harness: the underlying agent that does the actual
coding work. It is a Node CLI (`pi -p "<prompt>"`) that runs headless in a
container, reads Agent Skills from `~/.pi/agent/skills` and `~/.agents/skills`,
keeps its config under `~/.pi/agent` (`PI_CODING_AGENT_DIR`), and reaches its
model through a configured provider. pi reaches MCP servers through the
`pi-mcp-adapter` extension `e` installs in its image, and has no approval
popups; it is designed to run unattended. `e` supports several harnesses
(pi, Claude Code, Codex, opencode); pi is the primary one.

## What `e` is

`e` is the orchestration layer around the harness. It builds harness images,
cuts an isolated git worktree per run, injects the right provider/model
configuration, runs the harness inside a container, captures the agent's
changes, pushes the run branch, and opens a PR/MR. It also owns the store
(`~/.e`: agents, harness Dockerfiles, `.env`, config) and a local web UI
(`e serve`). You can think of `e` as: "build and run a coding agent, isolated,
against my gateway, results as a git branch".

## How `e` and `pi` relate

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

Read the diagram bottom-up:

- The user drives `pi`, the main agent harness.
- `pi` delegates work through `e` with `e spawn <agent> "<prompt>"`.
- Each spawned agent runs its own harness (pi or another) in an isolated
  container on its own worktree, with its own model/provider configuration.
- Agents can themselves spawn agents (see [Recursive spawning](#recursive-spawning)).

`e` sits between the harness and the work: it is the layer that makes
delegation, isolation, configuration delivery, and result collection work. The
harness is the layer that thinks and edits.

## Why the name `e`

`e` is named for Euler's number, the mathematical partner of `pi` (the harness).
Where `pi` is the constant at the heart of the agent, `e` is the constant that
stands around and beside it: `e` builds, wraps, isolates, and runs `pi`. The two
constants of Euler's identity (`e^(iπ) + 1 = 0`) are the pair this project's
name points at, `e` being the orchestration layer and `pi` the agent core.

## Is `e` available here?

Check first; do not assume:

```bash
command -v e
e --version
```

`e` is a host-side CLI. Inside a normal spawned run the host `e` is not
automatically on the container's `PATH`. Several signals tell you you are inside
an `e`-managed run:

- `$PI_CODING_AGENT_DIR` points under `/home/node` (pi harness) and your runner is `pi`.
- `/workspace` is a git worktree whose branch matches `e/<agent>/<slug>-N`.
- The project's `AGENTS.md` or `CONTEXT.md` mentions `e` runs and
  host-orchestrated git.
- Environment carries the run's injected values (platform base URLs and the
  provider's key referenced by name); provider and model arrive on pi's
  command line (`--provider e --model <id>`), not as env vars.
- `$E_ROLE` is set (`parent` or `child`) with `$E_BROKER_URL` next to it: the
  role contract of ADR-0013, delivered by the host per container.

Where `e` is not on `PATH` but the repo is `e`'s own source, the README's build
section documents a local alias:

```bash
alias e="node $(pwd)/dist/index.js"
```

Do not install or build `e` yourself unless the task explicitly asks for it;
building takes time and may be unwanted.

## Invoking `e`

The commands an agent (or user) actually uses:

| Command                                     | What it does                                          |
| ------------------------------------------- | ----------------------------------------------------- |
| `e spawn <agent-or-harness> "<prompt>"`     | Run an agent/harness against a prompt (one-shot)      |
| `e spawn <agent-or-harness>`                | Start the harness TUI (no prompt means interactive)   |
| `e spawn <agent-or-harness> --skill <name>` | Add a Skill for this run                              |
| `e spawn <agent-or-harness> --mcp <name>`   | Wire an MCP server (rejected for opencode)            |
| `e init`                                    | Write the store (`~/.e`); usually done on the host    |
| `e serve`                                   | Local web UI / BFF, and `e`'s A2A endpoint (ADR-0015) |
| `e --help`                                  | The full CLI                                          |

`e` finds its store by walking up from the working directory for a `.e`
directory, falling back to `~/.e`; `--dir <path>` overrides either.

## Delegating work with `e spawn`

The delegation primitive is one command:

```bash
e spawn researcher "Investigate the authentication implementation"
```

Details:

- The **target** is a persisted agent name (from the store's `agents/`) or a
  bare harness name (`pi`, `claudeCode`, `codex`, `opencode`), which resolves
  to that harness's default agent.
- The **prompt is the task context**: it is the whole instruction the child
  agent receives, so write the task, its acceptance criteria, and any
  constraints into it.
- The child runs in its **own** container and its **own** worktree. It is fully
  isolated from you; there is no shared process state and no live channel back.
- The child's model/provider come from its agent definition in the store, not
  from your environment.

## What a spawned agent receives (the contract)

| Aspect                | What the child agent gets                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Working directory     | `/workspace`: a disposable git worktree on branch `e/<agent>/<slug>-N`, cut from the host's HEAD. Only committed state carries over.                                                                                                                                                                                                                         |
| Environment           | Provider keys and base URLs injected from `.e/.env` (filtered to the run's needs, referenced by name). Harness variables such as pi's `PI_*`. The role contract set by the host per container: `E_ROLE` (`parent` \| `child`) and `E_BROKER_URL` (the runtime-broker endpoint, ADR-0013); never a marker file. Never host git credentials (ADR-0002).        |
| Agent instructions    | The launch prompt, prefixed with `e`'s worktree rules ("Do not run git add, git commit, git push, or git worktree: Git metadata and credentials intentionally remain on the host") and the role contract ("read it from `$E_ROLE` ... do not create or rely on parent/child marker files"). Project `AGENTS.md` / `CLAUDE.md` in `/workspace` if present.    |
| Model / provider      | From the agent definition: baked into the image where the harness needs a file (pi's `models.json`, Codex's `config.toml`) or delivered via env / CLI flag (Claude Code). Keys resolve by name; only pi bakes the key value (its CLI forces it).                                                                                                             |
| Tools                 | The harness CLI's native tools (pi: shell, file editing, ...), Agent Skills installed outside the worktree (`~/.agents/skills`, pi also reads `~/.pi/agent/skills`), plus any MCP sidecars chosen at spawn (delivered to pi via `pi-mcp-adapter`), and the runtime-broker sidecar with the `spawn-brother` skill when the run selects that skill (ADR-0013). |
| `e` CLI               | Only if the environment provides it. Check with `command -v e`. Do not assume it is installed, and do not install it yourself unless asked.                                                                                                                                                                                                                  |
| Permissions           | Non-root runtime user; full network egress to reach the model (some deployments route through the `e-egress` gatekeeper); no docker socket, no `NET_ADMIN`, no host git credentials (ADR-0002).                                                                                                                                                              |
| Parent task / context | The prompt text, plus whatever the worktree already contains. No mid-run channel to the parent; the worktree is the shared artifact.                                                                                                                                                                                                                         |
| Result / reporting    | File changes in `/workspace`; see the next section.                                                                                                                                                                                                                                                                                                          |

## How results return to the parent

There is no direct result channel between a spawned agent and its parent.
Results are returned through git, and `e` owns all git operations:

1. You make file changes in `/workspace` only. Do not run
   `git add` / `git commit` / `git push`; the host `e` process handles git
   (ADR-0002) and your worktree's `.git` points outside its mount anyway.
2. When your process exits, `e` commits any leftover uncommitted changes onto
   the run branch `e/<agent>/<slug>-N`.
3. If you exited with code 0 and the branch has commits beyond the run's base,
   `e` pushes the branch and, when a git platform is configured, opens a PR/MR
   into the branch the parent spawned from. The PR body is the prompt; the
   title is the branch's tip commit subject.

Practical consequences:

- The parent sees your work as a branch or PR/MR: the durable artifact is your
  diff, not your conversation.
- Write any report or handoff notes as files in `/workspace` so they are
  committed and visible to the parent.
- Exiting with code 0 matters: it is required for the push / PR/MR path.

## Recursive spawning

`e spawn` is not limited to one parent to child level. Any agent that has `e`
available can spawn further agents, including other harnesses:

```text
Main Agent
└── e spawn researcher
    ├── e spawn web-researcher
    ├── e spawn code-researcher
    └── e spawn documentation-researcher
```

A spawned agent must be able to use each other's capabilities without installing
or configuring `e` itself. That holds wherever the spawned environment already
provides `e` (for example `e`-managed dev environments, or the `e` repo itself
after a build). Check `command -v e` first.

Recursion is bounded by the sandbox limits of the current run: a run container
has no container runtime (docker/podman socket), no host git credentials, and
its worktree's `.git` is not reachable inside the container, so a nested
containerized run cannot execute from inside a single-run sandbox (ADR-0001,
ADR-0002). The one sanctioned way around it is the `spawn-brother` skill
(ADR-0013): with it, the host starts **sibling** runs for you through the
runtime-broker sidecar and, when each exits, merges its branch back into your
worktree (a merge commit; the report at `e-runs/<id>/report.md`, conflicts
left for you to resolve and signal with `--merge <id>`; `--watch` blocks until
a sibling's `taskState` needs you, `--cancel <id>` stops one, ADR-0015) - check
`$E_ROLE` and `$E_BROKER_URL`, see `AGENTS.md`. A Store agent with
`"transport": "a2a"` is a remote Agent2Agent agent: request it the same way,
and read its answer in the report (no branch to merge). Without it, delegation means requesting a new run at the
layer that owns the runtime: record the task and its acceptance criteria as a
file in the worktree, exit 0, and let the parent (or the host) spawn the
follow-up run. Recursive spawning therefore follows the limits the
implementation provides: enabled where `e` and a runtime are reachable, and a
clean handoff request where they are not.

## Delegation patterns

Prefer many small, parallel, independent agents over one large agent. Isolation
is per-run, so parallel children never collide on the worktree.

Role split (independent work items):

```text
Lead Agent
├── Architect
├── Backend Developer
├── Frontend Developer
├── Test Engineer
└── Reviewer
```

Recursive research (each researcher further splits its slice):

```text
Lead Agent
└── Research Agent
    ├── API Researcher
    ├── Codebase Researcher
    └── Documentation Researcher
```

Guidelines:

- Put the context the child needs into the prompt: goal, scope, acceptance
  criteria, files to start from, constraints ("read-only", "do not touch X").
- Name the target agent by capability (a store may already define agents named
  for roles) or use a bare harness name for a default agent.
- Fan out in parallel when the subtasks are independent; coordinate through the
  run branches / PRs the children produce.
- Review a child's PR/MR before merging; the pushed branch is the record of
  what was delegated.

## Where this document lives

This file is `docs/agents/e.md`. You did not need to know that path in advance:
`AGENTS.md` and the other `docs/agents/` documents point here. If you are an
agent and you found your way here by reading the project's agent documentation,
that is the intended entry point.
