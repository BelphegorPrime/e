# ADR-0014: The browser terminal starts runs through `serve` and attaches to their TTY

**Status:** Accepted
**Date:** 2026-09-11
**Related:** [ADR-0002 (host orchestrates git)](./0002-host-orchestrates-git.md), [ADR-0008 (spawn is a pure plan)](./0008-spawn-is-a-pure-plan.md), [ADR-0010 (serve BFF, observer-first UI)](./0010-serve-is-a-bff-observer-first-ui.md), [ADR-0013 (nested spawn via runtime-broker)](./0013-nested-spawn-via-runtime-broker.md)

## Decision

The web UI gains a Terminal page from which a user starts a new run for any
Store agent and works in the harness's own TUI, as if the harness ran in the
browser. `serve` implements this as a **headless `e spawn` child** per session
plus an **attach to the run container's TTY through the container engine's
API**. This is the second and last amendment to ADR-0010's observer-first
boundary: the UI may _start_ a run; it still cannot edit the Store, switch
models, or touch git.

## Decisions

### Starting a run is exactly `e spawn <agent> --name <slug>`

`POST /api/terminal/sessions {agent, name?}` spawns this same executable as a
child: `e spawn <agent> --name <slug>` in the directory `serve` was started in.
The child does everything the CLI does - image builds, the worktree, sidecars,
the commit/push/PR after the harness exits (ADR-0001, ADR-0002, ADR-0008). The
BFF adds no orchestration of its own and never touches git or containers for a
run; it only relays bytes. A run therefore outlives `serve`: killing the UI
server leaves the child and its container running to completion.

The child's stdout/stderr (build logs, `e`'s own messages, the final
"Run branch" report) is the first part of the session's terminal, so the
browser sees the whole run from build to push.

### No host PTY: the container's TTY is detached and attached over the engine API

`serve` has no TTY and must not grow a native PTY dependency (the `e` binary is
a single self-contained executable, `pkg --sea`). Instead the child runs with
`E_TTY_HEADLESS=1`, which makes an interactive run use `run -d -it` (the CLI
refuses `-it` without a host TTY, but not when detaching) followed by
`wait <id>` for the exit code - the run's exit code stays the container's, and
the commit-on-exit-0 rule is unchanged (`RunOptions.headlessTty`).

While the child is `starting`, `serve` polls the engine for a running container
named `e-<agent>-<slug>-N` (the run branch with slashes replaced, anchored so
sibling slugs never match), then hijacks `/containers/<name>/attach` with
`stdin+stdout+stderr+logs` on the engine's unix socket. Because the container
has a TTY, the stream is raw terminal bytes both ways; `/containers/<name>/resize`
delivers the browser's terminal size (`SIGWINCH` inside the container). The
engine socket is resolved from `DOCKER_HOST=unix://…`, then Docker's default
socket, then Podman's rootless service socket; without one, `serve` still runs
but refuses to start sessions with a clear message (`/api/info.terminal`).

The CLI's own `docker attach` was rejected: it also demands a host TTY. A
`script`/PTY shim was rejected: no resize, and platform-specific.

### One WebSocket per tab, sessions live in the `serve` process

`GET /api/terminal/ws?session=<id>` upgrades to a WebSocket: binary frames are
terminal bytes (keystrokes up, output down), text frames are JSON control
(`resize` up; `status` and `error` down). Any number of tabs may attach to one
session; a late tab gets a bounded replay buffer (512 KiB) and the current
status. Sessions are in-memory in `serve` - a restart forgets the terminal
view, not the run (which continues and lands on its branch like any other).

### Security: same-origin WebSocket, loopback bind, no auth

ADR-0010's "no auth while read-only" reasoning weakens with a start path, so
the surface is kept minimal: `serve` still binds `127.0.0.1`; the JSON POST
needs `application/json` (a cross-origin browser POST fails preflight, since
`serve` sends no CORS headers); and the WebSocket upgrade requires the
`Origin` header, when present, to name the serving host - browsers do not apply
the same-origin policy to WebSockets, so this is what stops another open page
from typing into a run. Non-browser clients (no `Origin`) are scoped by the
loopback bind. Anyone who can reach `serve` could already run `e spawn`; the
terminal grants no capability the local user did not have. Exposing `serve`
beyond loopback (`--host`) is where auth becomes a requirement - a separate
decision, as ADR-0010 already states.

## Consequences

- **The UI has exactly two writes:** egress blacklisting (ADR-0010) and
  starting a run (this ADR). Both are delegations to an existing mechanism
  (the egress API, `e spawn`); the BFF still holds no write logic.
- **`E_TTY_HEADLESS` is an internal contract** between `serve` and its child,
  like `E_SERVE_DETACHED`; it is not a user-facing flag.
- **Re-invoking `e` has one rule** (`selfInvocation` in `src/utils/selfInvoke.ts`):
  under plain Node the entry script is passed again, in the `pkg --sea`
  single-executable it is not - there `argv[1]` is the snapshot path of the
  embedded entry, which the executable would take for an unknown command. Both
  the terminal child and `serve --detached` go through it.
- **`serve` must be started inside a git repository**, since the runs it
  starts are `e spawn` runs in that directory.
- **Podman needs `podman system service`** for the engine socket; the CLI path
  alone is not enough.
- **The interactive-only key prompt does not work headless.** If the local
  OmniRoute key is missing, the child's readline prompt hits a closed stdin and
  the run fails with that message in the browser; run `e spawn` once in a
  terminal to create the key (ADR-0010 keeps the prompt in `spawn`).

## Out of scope

- Killing or signalling a run from the UI - the user exits the harness.
- Detached (`-d`) one-shot runs from the UI; the page is about the TUI.
- Restoring sessions across `serve` restarts (re-attaching to a still-running
  `e-*` container by name is possible with this design, not implemented).
