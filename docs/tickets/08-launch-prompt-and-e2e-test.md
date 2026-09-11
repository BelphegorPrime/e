# 08 - Launch-prompt role guidance and end-to-end test

**Partly shipped 2026-09-12** through ticket 01: `launchPrompt` in
`src/runs/runSpawn.ts` names the role and both variables for parent and child
and forbids marker files, so the prompt boxes below are done. The end-to-end
cycle remains.

**What to build:** Parent and child launch prompts instruct agents to check `$E_ROLE` / `$E_BROKER_URL` and state role behavior explicitly (no marker files). An end-to-end test runs the full cycle: parent spawns child via broker, child observes env, child requests a sibling, run completes, parent worktree contains sibling's merged changes.

**Blocked by:** 02 (broker sidecar), 06 (endpoint, depth cap), 07 (merge-back) for the end-to-end test; 01 shipped.

**Status:** blocked

- [x] Parent launch prompt references `$E_ROLE`/`$E_BROKER_URL` and role behavior (ticket 01)
- [x] Child launch prompt references `$E_ROLE`/`$E_BROKER_URL` and role behavior (ticket 01)
- [x] Neither prompt references or depends on marker files (ticket 01: the prompt forbids them)
- [ ] E2E test: parent spawns child, child sees env, child spawns sibling, parent ends with merged changes
- [ ] E2E test asserts depth cap enforced and `.env`/`.git` absent from child
