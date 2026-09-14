# Glossary

Canonical vocabulary for humans and agents working in this repository.
When your output names a domain concept, use the term as defined here.
Drifting to synonyms the glossary explicitly avoids causes ambiguity.

---

## Core Domain

| Term             | Definition                                                                                                                                                                                      | Avoid                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **Harness**      | A coding-agent CLI (Claude Code, Codex, opencode, pi) packaged to run inside a container. The _packaging_ only -- the model and configuration belong to an Agent.                               | tool, model              |
| **Agent**        | A named, reusable pairing of a Harness with a model configuration (provider endpoint, model, credentials). The selectable unit a Run executes. Does not own Sidecars.                           | harness, bot, assistant  |
| **Remote agent** | A Store agent with `"transport": "a2a"`: hosted elsewhere, speaks Agent2Agent protocol, has a URL instead of a harness image, no worktree or branch. Answer lives in the status `answer` field. | proxy, gateway           |
| **Provider**     | The model endpoint an Agent talks to: `baseUrl`, `model`, `protocol`, `apiKeyEnv`. Defined inline in the Agent, not a standalone Store entity.                                                  | model, backend, endpoint |
| **Run**          | The execution of one Agent in an isolated container with a disposable worktree, chosen Sidecars, and a runtime-broker if spawning. The durable artifact is the branch.                          | job, task, execution     |
| **Store**        | The directory `.e/` or `~/.e`, walked up from cwd. Contains harnesses, agents, skills, MCP servers, config, and secrets.                                                                        | config dir, workspace    |
| **Workspace**    | The container's bind-mounted checkout at `/workspace`. A disposable worktree per Run.                                                                                                           | store, repo              |

## Runtime & Execution

| Term               | Definition                                                                                                                                                     | Avoid                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Runtime**        | The container runtime that builds and runs images: docker, podman, nerdctl, finch.                                                                             | engine, backend                |
| **Worktree**       | A disposable Git checkout bind-mounted at `/workspace` inside the container. Created fresh per Run, deleted after.                                             | workspace, checkout, directory |
| **Branch**         | The durable Git artifact of a Run: `e/<agent>/<slug>-N`. Outlives the worktree.                                                                                | output, result                 |
| **Checkpoint**     | A commit made on spawn to snapshot current work before delegating to a sibling. Enables merge-back.                                                            | snapshot, save                 |
| **Sidecar**        | An auxiliary container composed alongside the agent container per-Run. Built from `mcp/*/` or `.e/broker/`. Supports the agent over a private per-run network. | service, plugin, addon         |
| **Runtime-broker** | Sidecar providing the HTTP contract for sibling-spawn coordination. Posts spawn requests, reports status, manages the fan-out cap.                             | broker, coordinator            |

## Spawning & Siblings

| Term            | Definition                                                                                                                        | Avoid                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **Spawn**       | `e spawn <agent> "<prompt>"`: delegates work to an isolated container running an Agent. Non-blocking.                             | start, launch, execute      |
| **Sibling**     | An agent spawned from within another Run (child of the current Run). Can request its own siblings (depth 2). Never deeper.        | child, sub-agent, delegate  |
| **Parent**      | The Run that issued `e spawn`. Its worktree gets the sibling's branch merged back.                                                | caller, source              |
| **Depth**       | How many levels of spawn nesting exist. Max depth: 2 (parent -> child -> grandchild refused).                                     | nesting, level              |
| **Fan-out cap** | Maximum concurrent siblings per parent (default 3). Requests return `429` while full.                                             | parallel limit, concurrency |
| **Merge-back**  | When a sibling finishes, its branch merges into the parent's worktree as a merge commit. Conflict resolution is the parent's job. | integration, combine        |

## Agent2Agent (A2A)

| Term                     | Definition                                                                                                                                              | Avoid            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **Agent2Agent protocol** | Wire protocol (ADR-0015) for inter-agent communication. Used by Remote agents and sibling spawns across harnesses.                                      | A2A, inter-agent |
| **taskState**            | The A2A lifecycle state: `submitted`, `working`, `input-required`, `completed`, `failed`, `canceled`, `rejected`. Branch on this to decide next action. | status, phase    |
| **Remote agent**         | An agent reached via A2A transport, not a local harness image. Its answer is the `answer` field, its merge status is `skipped`.                         | proxy, gateway   |

## Skills & MCP

| Term              | Definition                                                                                                                                           | Avoid                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **Skill**         | A `SKILL.md` plus resources that provide specialized instructions for specific tasks. Selected per Run. Loaded by the harness at runtime.            | plugin, extension, capability |
| **MCP server**    | A capability the agent connects to over Model Context Protocol. Types: `container` (runs as Sidecar), `remote` (URL-based), `stdio` (local process). | tool, extension               |
| **MCP transport** | How the agent reaches an MCP server: `container` (Sidecar), `remote` (URL), `stdio` (child process).                                                 | connection, channel           |
| **Adapter**       | `HarnessAdapter`: renders native harness config from Agent definition. Env or File type. Baked into image layers.                                    | renderer, translator          |

## Caveman Communication

| Term                     | Definition                                                                                                                                                       | Avoid                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **Caveman mode**         | Ultra-compressed communication style. Cuts output tokens ~65%. Persistent across responses until disabled.                                                       | compression, terse mode |
| **Caveman intensity**    | Levels: `lite` (no filler, keep articles), `full` (default, drop articles, fragments OK), `ultra` (strip conjunctions), `wenyan-*` (classical Chinese variants). | level, setting          |
| **Caveman auto-clarity** | Mode suspends for security warnings, irreversible actions, or ambiguous sequences. Resumes after.                                                                | exception, override     |

## ADR Numbers

Quick reference for Architecture Decision Records referenced throughout:

| ADR      | Title                          | Key Concept                                          |
| -------- | ------------------------------ | ---------------------------------------------------- |
| ADR-0001 | Branch outlives worktree       | Durable artifact is the branch, not the workspace    |
| ADR-0007 | Auto model resolution          | `model: "auto"` resolves concrete model at run start |
| ADR-0013 | Sibling spawn                  | Runtime-broker sidecar, depth-2 limit, fan-out cap   |
| ADR-0015 | A2A vocabulary & remote agents | Remote agent type, taskState lifecycle               |

## Triage Labels

| Label             | Meaning                       |
| ----------------- | ----------------------------- |
| `needs-triage`    | Maintainer needs to evaluate  |
| `needs-info`      | Waiting on reporter           |
| `ready-for-agent` | Fully specified, AFK-ready    |
| `ready-for-human` | Requires human implementation |
| `wontfix`         | Will not be actioned          |

## Protocols & Formats

| Term                 | Definition                                             |
| -------------------- | ------------------------------------------------------ |
| `openai-chat`        | Wire protocol for OpenAI-compatible chat completions   |
| `openai-responses`   | Wire protocol for OpenAI Responses API                 |
| `anthropic-messages` | Wire protocol for Anthropic Messages API               |
| `agent.json`         | Agent definition file in the Store                     |
| `config.json`        | Host-only Store configuration                          |
| `.env`               | Shared secrets file in `.e/` (never baked into images) |
