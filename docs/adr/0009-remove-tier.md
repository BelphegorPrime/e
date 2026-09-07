# Remove Tier: agents are selected by name only

Supersedes the "Tier selects an agent" half of ADR-0007, and the Tier-carrying
parts of ADR-0004/0006/CONTEXT.

## Decision

Drop **Tier** entirely. An `Agent` no longer carries a `tier` field; `e spawn`
no longer has a `--tier <tier>` option; agents are addressed only by their
persisted name (or a bare harness name, which resolves to that harness's single
default agent). The on-disk layout drops the tier subdirectory:
`agents/<name>/agent.json` (was `agents/<name>/<tier>/agent.json`).

`auto` model resolution (the other half of ADR-0007) still applies, minus the
tier dimension. The curated per-`(protocol, tier)` preference list and the
`e`-side spawn resolver are removed entirely; see
[ADR-0007](./0007-auto-model-delivery.md) for how `auto` is delivered and
resolved after this change.

## Why

Tier added a second, largely redundant axis for what a distinct Agent name
already expresses (`smart-claude` vs `cheap-codex` says the same thing `--tier`
did). It also forced every curated preference list to be duplicated four ways
(`smart`/`fast`/`cheap`/`review`) for a distinction few users acted on. A named
Agent per configuration is simpler to reason about and to persist.

## Consequences

- Existing `.e/agents/<name>/<tier>/agent.json` layouts from before this change
  are not migrated automatically; re-run `e init` (or move `<tier>/agent.json`
  up a level) to pick up the new layout.
- The `e`-side curated preference list and spawn-time model resolution are
  deleted; `auto` now resolves in the harness at run start (ADR-0007). A user
  needing a pinned model sets a concrete `model` on the agent rather than
  picking a tier at spawn time.