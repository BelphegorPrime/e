# Tiers select agents, and drive `auto` model resolution against `/v1/models`

A **Tier** is a capability/cost class of an Agent (ADR-0004, CONTEXT glossary). It
has two jobs, and this decision records both plus the curated data behind the
second.

## Tier selects an agent

Many Agents can share a Harness, differing by Tier. `e spawn <harness> --tier
<tier>` (or, with a favorite harness, `e spawn --tier <tier> "…"`) resolves to the
single persisted Agent whose `(harness, tier)` matches. **Zero or more than one
match is an error** that lists the candidates — the selection must be
unambiguous, never "pick the first". A bare harness name still resolves to that
harness's `default`-tier agent, unchanged.

## Tier drives `auto` model resolution

An Agent's Provider `model` is either a concrete id (**baked** into the derived
image — ADR-0004) or `auto`. For `auto`, `e` resolves a concrete model **at
spawn** and delivers it via the runtime overlay (ADR-0006), never baking it:

1. Query the provider's model list (`/v1/models` for OpenAI-shaped endpoints,
   `/v1/models` for Anthropic).
2. Walk `e`'s curated preference list for `(protocol, tier)` in order; the first
   preferred id that is a **prefix of** an available id wins (so a versioned id
   like `claude-opus-5-20260101` matches the preferred `claude-opus-5`).
3. If nothing matches, or the endpoint is unreachable, fall back to the
   Provider's optional `defaultModel`; if that is absent too, fail with a clear
   error naming what was tried.

Delivery of the resolved model is per-harness, mirroring the adapter's delivery
form (ADR-0006): an **env** harness (Claude Code) carries it in `ANTHROPIC_MODEL`
at runtime; a **file** harness (Codex) omits the `model` line from the baked
`config.toml` and receives the resolved id at runtime via `codex exec -m <id>`.
A concrete (non-`auto`) model keeps the baked path from ADR-0004 unchanged.

## The curated preference list (HITL)

This list is an opinionated call, reviewed by a human before encoding. The
first-class tiers are:

- **`smart`** — the most capable model: deep reasoning, architecture, hard debugging.
- **`fast`** — a balanced capability/latency model for everyday coding.
- **`cheap`** — the cheapest/fastest model for trivial or bulk work.
- **`review`** — a careful, analytical model for code review and critique.

`default`-tier agents are not in the list: they carry a concrete model and skip
auto resolution entirely.

Initial rankings (first available wins), tuned to the maintainer's gateway,
whose model ids are **namespaced by provider** (`anthropic.…`, `openai.…`).
Matching is exact or a preferred id followed by a version/date suffix
(`anthropic.claude-haiku-4-5` → `anthropic.claude-haiku-4-5-20251001-v1:0`).

| protocol | smart | fast | cheap | review |
|---|---|---|---|---|
| `anthropic-messages` | claude-opus-5, claude-sonnet-5 | claude-sonnet-5, claude-haiku-4-5 | claude-haiku-4-5, claude-sonnet-5 | claude-opus-5, claude-sonnet-5 |
| `openai-responses` | gpt-5.6-sol, gpt-5.5 | gpt-5.6-terra, gpt-5.5 | gpt-5.6-luna, gpt-oss-20b | gpt-5.6-sol, gpt-5.6-terra |
| `openai-chat` | gpt-5.6-sol, gpt-5.5 | gpt-5.6-terra, gpt-5.5 | gpt-5.6-luna, gpt-oss-20b | gpt-5.6-sol, gpt-5.6-terra |

(ids above are shown without their `anthropic.` / `openai.` namespace for
brevity; the encoded list carries the full namespaced ids.)

The `gpt-5.6` variants form a capability ladder — **luna < terra < sol**, the
haiku / sonnet / opus equivalents. `google` is **not curated**: the gateway
offers only Gemma (no Gemini), so a `google` + `auto` provider gets a clear
"no preference list" error rather than a guessed Gemma; a concrete `model` or
`defaultModel` still works.

## Considered options

- **Bake `auto`-selected models** — rejected (ADR-0004): goes stale the moment a
  new model ships and needs build-time network access and credentials.
- **A single global model ranking, not per-protocol** — rejected: a Claude id is
  meaningless to an OpenAI endpoint; the available set is protocol-specific.
- **First-match-wins tier selection** — rejected: silently picking among several
  `(harness, tier)` agents hides a misconfiguration; ambiguity must error.

## Consequences

- `e` carries a maintenance burden: the preference list drifts as models ship
  and is tuned to one gateway's namespaced ids; another gateway may need a
  concrete `model` or `defaultModel`, or an edit to the list.
- Auto resolution makes a network call at spawn; it must degrade gracefully
  (`defaultModel`, then a clear error) so a flaky endpoint never hangs a run.
- The models-list HTTP client is a seam so tests fake the endpoint; only
  `anthropic-messages` and `openai-*` protocols are wired initially.
