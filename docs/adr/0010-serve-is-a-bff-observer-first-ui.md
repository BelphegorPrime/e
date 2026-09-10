# Serve is a BFF; the UI is an observer-first, read-only window

The `e serve` command becomes the backend-for-frontend (BFF) for a local web
UI, and OmniRoute is confirmed as a **core** component of the stack: not an
optional dev convenience. This ADR records the architecture-review decisions
covering the UI contract, the OmniRoute role, the `serve` role, the API
surface, `serve`'s (non-)auth model, and the runs index.

## Decisions

### OmniRoute is a core component

OmniRoute (composed with llama.cpp and Redis per ADR-0005) is the AI gateway:
it terminates every harness's model API traffic, adds provider models
(load-balancing and failover across `planSpawn`'s provider set), and serves the
local llama.cpp endpoint. It is **not** an optional dev-stack sidecar; the
CLI's provider delivery, `auto` model resolution (ADR-0007), and the future
UI's model views all assume it. The UI exposes OmniRoute information (reachable
models, provider status) via the BFF.

### `serve` is a BFF

`e serve` proxies OmniRoute for a browser UI and serves the bundled static UI
plus API endpoints. It is host-side, binds `127.0.0.1` by default, and holds
the gateway key in the **proxy process only**: read from `.e/.env` at startup,
never shipped to the browser. This keeps secrets out of the client; the browser
talks only to `serve`, which talks to OmniRoute with the key it already owns.

### One `/api` root, namespaced

The API lives under a single `/api` root with namespaces:

- `/api/info`: serve/stack status (extends the existing health/info surface).
- `/api/runs/*`: the runs index and per-run status/logs.
- `/api/omniroute/*`: gateway-derived views (models, provider status).
- `/api/egress/*`: egress log views and the single delegated mutation — on-the-fly domain blacklisting (see below).

UI views aggregate these; there is no second ad-hoc API surface.

### The UI is observer-first and read-only

The UI observes: a runs list derived from git branches (ADR-0003's run
identity), per-run status and logs, and the store configuration view. It
performs **no writes**: no branch creation, no config mutation, no model
switching. Read-only keeps the observer honest (no session-state to lose) and
defers auth entirely (below).

**One exception — delegated egress blacklisting.** On-the-fly domain
blacklisting is the single mutation the UI may carry. It is not a general
write path: the action is mediated end-to-end by the egress container's own
API (POST/DELETE on the blacklist, applied immediately via the existing SIGHUP
reload), proxied by `serve` under `/api/egress/*`. The BFF adds no write layer
of its own; it only forwards the one delegated call. This exception is the
**sole** amendment to the observer-first boundary; it does not open a general
UI write path.

### `serve` is local-only, unauthenticated

Because the UI is read-only and binds `127.0.0.1`, `serve` adds **no auth**: no
login, no session cookie, no CSRF surface. The gateway key stays inside the BFF
process. If a future UI needs writes, auth becomes a requirement: a deliberate,
separate decision, not an increment of this one.

### The key prompt stays in `spawn`

The OmniRoute dashboard key prompt (the "create an API key" flow when `auto`
model discovery needs an endpoint key) remains inline in `e spawn`. There is no
`e login` command; the prompt writes the key into `.e/.env` and continues. A
separate login surface is deferred until a UI write path exists.

### The runs index is branch-backed

`/api/runs/*` resolves runs from git branches (`refs/heads/run/*` per
ADR-0003) until the UI needs live timing or streaming logs. Branch-backed
indexing is cheap, durable, and already canonical (runs _are_ branches); live
log/timing views are an incremental addition to the same namespace.

## Consequences

- **`serve` grows a proxy layer, not a write layer.** The BFF's delta over
  today is proxying OmniRoute and exposing branch-backed run views: both
  read-only. No session store, no auth middleware, no UI write path.
- **Secrets stay server-side by construction.** The gateway key never enters
  bundled UI code; the browser cannot read `.e/.env` or OmniRoute's credentials
  (see `docs/security/attack-surface.md`, Zone 4).
- **The UI cannot mutate state — with one delegated exception.** Observer-first is a hard boundary; the runs
  list, status, config view, and model views are all reads. The sole mutation is egress blacklisting, mediated by the
  egress container's own API and forwarded by `serve` — never a direct UI write to the store.
- **Interactive `init` may ask about compose startup.** `e init` may prompt
  whether `e spawn` should auto-start the compose stack (`autoComposeUp`) and
  record the choice in `config.json`; `init --yes` defaults to `true`
  (preserving today's behavior). No CLI flag is added.

## Status

Decided in the architecture review. The UI is a stub today; `serve` will be
extended to the BFF surface as follow-up issues. The security fixes tracked as
issues [#24](https://github.com/BelphegorPrime/e/issues/24) and
[#25](https://github.com/BelphegorPrime/e/issues/25) touch the compose stack
this ADR treats as core. The remaining implementation rests are tracked:
[#29](https://github.com/BelphegorPrime/e/issues/29) (key prompt, blocked by
#25) and [#30](https://github.com/BelphegorPrime/e/issues/30) (branch-backed
runs index, observer-first UI).
