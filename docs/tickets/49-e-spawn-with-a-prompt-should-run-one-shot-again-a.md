# 49 - e spawn with a prompt should run one-shot again; a bare target opens the TUI

**Status:** Done (closed 2026-09-12).

**GitHub:** [#114](https://github.com/BelphegorPrime/e/issues/114)

---

## What to build

`e spawn <agent-or-harness> "<prompt>"` runs the prompt as a one-shot Run and exits when the harness is done, as the README cheat sheet, the Usage examples, `docs/agents/e.md`, AGENTS.md, and the `e init` "Next steps" hint (`e spawn "<prompt>"`) all promise. `e spawn <agent-or-harness>` without a prompt opens the harness TUI in the container.

Today the default is inverted: a Run is interactive unless `-d/--detached` is passed, and the interactive command drops the prompt, so `e spawn pi "fix the bug"` opens the TUI and the prompt is silently lost. The flip happened in commit 3d52d4e (2026-09-10), which replaced the opt-in `-i/--interactive` with the opt-in `-d/--detached` without updating the documented contract.

Wanted contract:

- Prompt present -> one-shot detached Run (`<harness> -p "<prompt>" ...`), regardless of `-d`.
- No prompt -> interactive TUI.
- `-d/--detached` stays as an explicit flag: a no-op when a prompt is present, still an error ("A prompt is required for detached runs.") without one.
- The browser terminal (`e serve`, headless TTY) keeps starting interactive Runs as it does now; it passes no prompt.

Docs move with the code (AGENTS.md rule): README Usage examples and Cheat sheet, `docs/agents/e.md` invocation table, ADR-0008 where it names the flag, the `e init` next-steps hint, and the tutorials under `docs/tutorials/` (which currently insist on `-d` for every one-shot example) are updated in the same change so no document still shows a mandatory `-d`.

## Acceptance criteria

- [ ] `e spawn pi "print hello"` builds the one-shot command (`pi -p "print hello" ...`) and never the interactive one; covered by a spawn plan / facts test.
- [ ] `e spawn pi` (no prompt) plans an interactive Run; covered by a test.
- [ ] `e spawn -d pi` (no prompt) still fails with the existing "A prompt is required for detached runs." error; `e spawn -d pi "x"` behaves exactly like `e spawn pi "x"`.
- [ ] A headless spawn started by the browser terminal (`e serve`) is still interactive.
- [ ] `npm test`, `npm run lint`, `npx prettier --check .` pass.
- [ ] README (Usage examples, Cheat sheet), `docs/agents/e.md`, ADR-0008, the `e init` next-steps hint, and `docs/tutorials/*.md` describe the same contract; `-d` appears only as an optional explicit flag.

## Blocked by

- None - can start immediately.
