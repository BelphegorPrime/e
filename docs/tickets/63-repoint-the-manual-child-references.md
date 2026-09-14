# 63 - Repoint the manual-child references off "ticket 09"

**Status:** Open, ready-for-agent.
**GitHub:** Pending - will mirror the created issue.

The ADR-0013 addendum and the CONTEXT.md glossary name the Manual child
work as "ticket 09" - but that number already belongs to the open
spool-read-tolerance ticket. Everywhere the feature is referenced by ticket
number, the reference is wrong and will misdirect a reader to the wrong
issue. This ticket renames those references so the ADR amendment and
glossary point at the Manual child feature's own tickets (once created,
the issue numbers of tickets 62, 64, 65, 67, 68 and 69 of this series);
until the issues exist, drop the number and name the feature plainly rather
than reusing a taken one.

**Blocked by:** None - can start immediately.

- [ ] No document claims "ticket 09" for the Manual child work.
- [ ] The ADR-0013 amendment's cross-references resolve to real tickets/issue numbers or name the feature without a number.
- [ ] CONTEXT.md glossary says the same, so the two sources cannot disagree.
