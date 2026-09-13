# 62 - E_MAX_SIBLINGS environment override for the fan-out cap

**Status:** Open, ready-for-agent.
**GitHub:** Pending - will mirror the created issue.

How many children a Parent run may have in flight is today fixed by
`config.json` (`maxSiblings`, default 3) at spawn planning time. This
ticket makes that cap settable from the environment: read `E_MAX_SIBLINGS`
when planning a parent run, with the existing `config.json` value winning
when both exist, and the built-in default when neither does. The cap stays
shared across request sources - broker siblings and Manual children alike -
because it is enforced by the parent's `SiblingConsumer` counting
spool-sourced launches, which this ticket does not change.

Why a ticket: the ADR-0013 addendum names `E_MAX_SIBLINGS` as the
adjustment knob, but only the `config.json` path exists today. Either the
env var becomes real or the ADR is wrong; this ticket makes it real.

**Blocked by:** None - can start immediately.

- [ ] `E_MAX_SIBLINGS` is read when the host plans a parent run; precedence is `config.json` > env > default 3, and an invalid value falls back.
- [ ] Existing behaviour unchanged when the variable is absent.
- [ ] Unit tests cover precedence and the invalid-value fallback.
- [ ] The ADR addendum's "same fan-out cap" text is now accurate, and the variable is documented in the glossary or ADR.
