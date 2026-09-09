# `auto` model delivery: the harness resolves, `e` carries no catalog

## Decision

An Agent's Provider `model` is either a concrete id or `auto` (the value
seeded defaults carry: `agent.ts` seeds `model: 'auto/coding'`). For `auto`, `e` does
**not** resolve a concrete id itself and ships **no curated model catalog**.
`auto` travels through the Provider delivery form (ADR-0006) to the harness,
and the harness resolves a concrete model against the endpoint's model list at
run start:

- **env harness (Claude Code):** the provider block reaches the run as runtime
  env, so `ANTHROPIC_MODEL=auto` is delivered and Claude picks at run start.
- **file harness, `modelInFile: false` (Codex):** the baked `config.toml`
  stays model-agnostic and the run command carries the model: `codex exec -m
auto` resolves against the endpoint.
- **file harness, `modelInFile: true` (pi):** pi selects only models
  **declared** in its `models.json`, so `e` declares `auto` there (the custom
  provider block baked into the derived image) and passes it on the command
  line (`--provider e --model auto`); pi expands `auto` internally (its
  `best-coding` policy) against the configured provider at run start.

A concrete (non-`auto`) model keeps the ADR-0004 path unchanged: baked into
the derived image where the harness is file-configured, env-delivered where it
is env-configured.

An earlier `e`-side resolver picked a preferred id from a curated,
per-`(protocol, tier)` list by querying the endpoint's `/v1/models` at spawn.
That machinery is gone: it drifted as models shipped, was tuned to one
gateway's namespaced ids, and duplicated resolution the harnesses do natively
(pi in particular ships its own `auto` policy). Removing it is part of the
tier removal (ADR-0009).

## Considered Options

- **Bake the resolved model into the image**, rejected for general use
  (ADR-0004): goes stale the moment a new model ships and needs build-time
  network access and credentials. pi's file adapter is the one structural
  exception, but it bakes the `auto` declaration (its CLI must select a
  declared model), never a resolved pick.
- **A single global model ranking, not per-delivery-form**, rejected: a Claude
  id is meaningless to an OpenAI endpoint; the available set is endpoint- and
  protocol-specific, which is the harness's own concern at run start.
- **An `e`-side curated preference list (HITL)**, tried and removed: see the
  decision above; the harness-native path makes the list maintenance a net
  cost.

## Consequences

- `e` carries no model-catalog drift: a newly shipped model is picked at the
  next run, not after an `e` change.
- `auto` still needs a live endpoint at run start; resolution and its
  degradation (fallback or clear error) are the harness's behavior. An agent
  that must pin a model sets a concrete `model` in its declaration.
- pi is the declaration exception: its CLI must select a model declared in
  `models.json`, so `e` bakes the provider block (with `auto`) into the derived
  image and passes `--model auto` at run start; a concrete model changes the
  baked image and needs a rebuild (`--rebuild`), `auto` does not.
