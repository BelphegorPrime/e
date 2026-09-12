# ADR-0015: A2A - the task vocabulary inside, a facade on `serve`, remote agents in the Store

**Status:** Accepted
**Date:** 2026-09-12
**Related:** [ADR-0002 (host orchestrates git)](./0002-host-orchestrates-git.md), [ADR-0008 (spawn is a pure plan)](./0008-spawn-is-a-pure-plan.md), [ADR-0010 (serve is a BFF)](./0010-serve-is-a-bff-observer-first-ui.md), [ADR-0013 (nested spawn via runtime-broker)](./0013-nested-spawn-via-runtime-broker.md), [ADR-0014 (browser terminal starts runs via serve)](./0014-browser-terminal-starts-runs-via-serve.md)

## Context

The Agent2Agent protocol (A2A, Linux Foundation, 1.0 in 2026) standardises how
independent agents discover each other (an agent card), delegate work (a task
with a lifecycle: `submitted`, `working`, `input-required`, `completed`,
`canceled`, `failed`, `rejected`), and exchange results (messages and
artifacts) over JSON-RPC with server-sent events. It is the agent-to-agent
counterpart of MCP, which `e` already speaks for agent-to-tool.

`e`'s own agent-to-agent path is ADR-0013: an agent asks the host, through
the runtime-broker, for a sibling run; the host starts it, and the result
comes back as git - a merge commit into the parent's live worktree, with a
report file. Nothing in that path is an agent talking to an agent over a
network. The question this ADR answers is where A2A helps `e` and where it
would hurt.

## Decision

Three things, and one thing deliberately not done.

### 1. The broker keeps its contract; it adopts A2A's vocabulary

The spool protocol between broker and host stays what it is (files, four
routes, Node built-ins only). It gains what A2A's lifecycle has and it lacked:

- Every sibling record carries `taskState`, the A2A state derived once, in
  `src/broker/taskState.ts`, from the run state and the merge-back:
  `requested` → `submitted`; `starting`/`running` → `working`; `done` →
  `completed`, or `failed` when it exited non-zero, or `input-required` while
  its merge-back is `conflict` or `held` (waiting on the parent);
  `failed`/`canceled`/`rejected` as is. Agents branch on `taskState`; the run
  states stay for what they describe, the sibling process.
- Two new run states: `canceled` (the parent's `POST /cancel/<id>`, or the
  parent run ending before pickup) and `rejected` (the host refusing after the
  broker accepted, today the depth rule). Both are settled with a skipped
  merge-back and a report, like every other end.
- `POST /cancel/<id>` (A2A `tasks/cancel`): spooled as `cancels/<id>.json`; a
  waiting request is canceled on the next tick, one in flight has its `e spawn`
  process stopped. That process now treats SIGTERM as a cancel
  (`RunSpawnParams.abort`): the container is removed, the normal teardown
  runs, nothing is committed. Before, SIGTERM exited the process and left the
  container running.
- `GET /status/events` (A2A streaming): the status as server-sent events, one
  `status` event now and one per change, polled off the spool because
  `fs.watch` is unreliable on bind mounts. The skill's `--watch [id]` blocks
  on it until a sibling needs attention. `e serve` exposes the same stream
  per run at `/api/runs/<branch>/siblings/events` for the UI.

### 2. `e serve` is an A2A agent

The BFF publishes an agent card at `/.well-known/agent-card.json` and one
JSON-RPC endpoint, `POST /a2a`, speaking the A2A 1.0 binding (`SendMessage`,
`SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`,
`SubscribeToTask`; the 0.x slash names such as `message/send` are accepted as
aliases; push notifications refused with the protocol's own error).
`SendMessage` always returns the submitted task at once - a run takes minutes
and the spec lets a server answer before the task is over - so clients poll
`GetTask` or stream.
Each harness agent in the Store is one skill; a message names the skill it
wants in `metadata.agent`. A task is exactly one run: `serve` launches a
headless `e spawn <agent> --detached -- <prompt>` child (the ADR-0014 pattern)
carrying `E_SPAWN_REPORT_SPOOL` / `E_SPAWN_REPORT_ID`, so the run writes the
same status records a sibling would - into a spool `serve` owns - and the task
is rendered from them (`src/a2a/tasks.ts`). The artifact of a completed task
is the run branch, whether it was pushed, and the PR/MR URL. Tasks take no
follow-up messages: a run has no input channel once started, and the card
says so.

Access follows ADR-0010/0014: open on loopback, where anyone could run
`e spawn` anyway; with `E_A2A_TOKEN` set the endpoint requires that bearer
token; bound beyond loopback without a token the endpoint stays off (card 404,
endpoint 503) with a warning. The card advertises the bearer scheme when it is
required.

### 3. Remote A2A agents are Store agents

An `agent.json` with `"transport": "a2a"`, a `url`, optional `headers` with
`${VAR}` references (resolved from `.e/.env` on the host at call time, never
stored) and an optional `description` is a **remote agent**: the mirror image
of a `remote` MCP server. It is selected by name like any agent, has no
harness, image or worktree, and is answered over the wire:

- `e spawn <remote> "<prompt>"` sends the prompt, follows the task, prints the
  answer; no branch, no PR. A prompt is required.
- As a sibling (`spawn-brother.mjs <remote> "<task>"`) the host talks A2A
  in-process instead of starting a child process; the answer lands in the
  status (`answer`) and the report (`## Answer`); the merge-back is `skipped`
  for lack of a branch. Cancel maps to `tasks/cancel`.

### Not done: A2A as the internal sibling protocol

The broker does not speak A2A to the agent, and run containers do not become
A2A servers. The reasons, recorded so the question does not come back with
the same answer at a higher cost:

- The result of a sibling is git - a merge commit into a live worktree, with
  conflicts left for the parent. A2A has no representation for that; it would
  ride as a proprietary data part, leaving only the envelope standard.
- The harnesses run headless and one-shot. They cannot receive a message
  mid-run, so `input-required` from a child, streaming into a child, or
  multi-turn tasks have no consumer. What they can do - poll, or block on one
  stream - the broker now offers without a JSON-RPC envelope.
- An A2A server per run container is a listening port in the sandbox and a
  reason for containers to reach each other; ADR-0002/0013 keep the container
  without either. The one A2A endpoint `e` has is host-side, on `serve`.
- The broker bundle is Node built-ins only and dependency-free; an A2A SDK
  would break that for a subset of the protocol.

## Consequences

- **One lifecycle vocabulary.** The skill, the reports, the web UI and any
  A2A client read the same seven states; `taskState` is derived, never
  stored, so it cannot drift from the run state and the merge-back.
- **Cancel exists.** For siblings (`--cancel`) and for A2A tasks
  (`tasks/cancel`); both end in the run's container being removed. A run
  process's SIGTERM is now a graceful cancel with a 60 s fallback exit.
- **Two new spool conventions.** `cancels/<id>.json` next to
  `signals/<id>.json`; request ids `a2a-NNN` next to `sib-NNN`
  (`isRequestId` accepts both, `nextRequestId` counts per prefix).
- **Two new env markers and one variable.** `E_SPAWN_REPORT_SPOOL` /
  `E_SPAWN_REPORT_ID` (internal, like the sibling markers; a sibling never
  carries them) and `E_A2A_TOKEN` (user-facing, for `serve`).
- **`Agent` is a union.** `HarnessAgent | RemoteA2aAgent`; the spawn pipeline
  takes a `HarnessAgent` and a remote target is answered before any fact is
  gathered (`resolveRemoteTarget`). `listAgents` and the UI's agent list show
  remote agents with `transport: "a2a"`; the agent card does not offer them
  (that would be proxying).
- **`serve` has a third write.** Egress blacklisting (ADR-0010), starting a
  run from the terminal (ADR-0014), starting a run over A2A (this ADR); all
  three delegate to an existing mechanism, and the BFF still holds no
  orchestration.
- **A2A 1.0 on the wire, tolerant on the way in.** `e` emits the 1.0 shapes
  (RPC method names, `TASK_STATE_*`, `ROLE_*`, parts as `{text}` / `{data}`,
  stream results wrapped by type, `securitySchemes` / `securityRequirements`
  in proto-JSON form, `A2A-Version: 1.0`) and reads the 0.x spellings too. The
  spec's own error codes (-32001 … -32009) are used where they apply.
- **Interoperability is tested against the reference SDK**, not the prose of
  the spec: `src/a2a/interop.test.ts` drives the facade with `@a2a-js/sdk`'s
  client (card, send, stream, get, list, cancel, bearer) and `e`'s client
  against the SDK's server (top-level spawn, sibling, cancel). The SDK is a
  dev dependency only; nothing of it ships. That test is what caught the 1.0
  method names and the card's security shapes, which the spec summaries had
  wrong.

## Out of scope

- Push notifications (webhooks), the extended agent card, gRPC and HTTP+JSON
  bindings, multi-tenant fields.
- Offering remote agents as skills of `e`'s own card.
- Follow-up messages to a running task; a task is one run.
- Restoring A2A tasks across a `serve` restart (the runs survive, the task
  view does not, like terminal sessions).
