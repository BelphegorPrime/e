# 23 - Tiers and auto model resolution via /v1/models

**Status:** Done (closed 2026-08-08).

**GitHub:** [#12](https://github.com/BelphegorPrime/e/issues/12)

---

## What to build

**Type: HITL** — the curated tier→model preference list is an opinionated call that needs human review before it is encoded.

Introduce **Tier** as an Agent attribute so multiple agents per harness can differ by tier; `e spawn <harness> --tier <tier>` (and, with a favorite harness set, `e spawn --tier <tier> "…"`) selects the matching agent. Support `model: auto`: at spawn, query the provider's `/v1/models`, pick the best-available model for the tier from `e`'s curated per-protocol preference list, and deliver it via the runtime overlay (ADR-0006). Fall back to a declared `defaultModel` or a clear error when nothing matches or the endpoint is unreachable.

## Acceptance criteria

- [ ] `agent.json` carries `tier`; `--tier` resolves to a single (harness, tier) agent; 0 or >1 matches → error listing candidates.
- [ ] `model: auto` resolves at spawn via `/v1/models` against the per-protocol/tier preference list; a concrete model still works (baked path).
- [ ] Fallback to `defaultModel` or a clear error on no match / unreachable endpoint.
- [ ] The initial curated preference list is reviewed by a human (HITL) and documented.
- [ ] Tests for tier selection and auto-resolution (with a faked models endpoint); `npm test` passes.

## Blocked by

- #10
- #11
