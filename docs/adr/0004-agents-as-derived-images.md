# Agents are configured wrappers over Harnesses, built as derived images

An **Agent** pairs a Harness with a **Provider** (endpoint, model, protocol,
key-name) and is the unit a Run executes. It is realized as a _derived image_
built on the harness base with the Docker builder pattern: layer 1 is the shared
harness base image (the CLI plus the code toolchain: Node/Python/Go); layer 2 is
the agent image (`FROM` the base) that bakes the static provider/model config.
Agents are declared as data (`.e/agents/<name>/agent.json`); `e` renders the
derived Dockerfile and config from the declaration and, like `e init` does for
harness Dockerfiles, never overwrites hand edits, showing a diff instead.

`e spawn` resolves to an Agent: a bare harness name resolves to that harness's
default agent. A run branch is `e/<agent>/<slug>-N`.

## Considered Options

- **Runtime-only config over one shared per-harness image**, rejected: agents
  genuinely differ in _installed software_ (language toolchains, extra tooling),
  which is a build-time concern, not data.
- **One flat image per agent with everything baked**, rejected: rebuilds the
  shared CLI/toolchain layer for every agent; the builder pattern shares that
  layer and bakes only the thin config on top.
- **Hand-written derived Dockerfiles per agent**, rejected: forces the user to
  know Docker _and_ each harness's native config format, defeating the
  per-harness config adapter (ADR-0006).

## Consequences

- A `model` is baked only when it is a concrete id; `auto` is delivered at
  runtime and resolved by the harness (ADR-0007).
- Changing an agent's static config rebuilds its cheap layer-2 image, not the
  base.
- Run identity moved from `e/<harness>/...` to `e/<agent>/...`, touching the
  counter/branch code (`prefix`, `listRunBranches`, `maxRunCounter`).
- `e` ships default agents; users add their own, mirroring how harnesses and
  MCP servers are shipped-plus-extendable.