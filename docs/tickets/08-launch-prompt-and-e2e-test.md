# 08 — Launch-prompt role guidance and end-to-end test

**What to build:** Parent and child launch prompts instruct agents to check `$E_ROLE` / `$E_BROKER_URL` and state role behavior explicitly (no marker files). An end-to-end test runs the full cycle: parent spawns child via broker, child observes env, child requests a sibling, run completes, parent worktree contains sibling's merged changes.

**Blocked by:** 01 — Env injection: E_ROLE and E_BROKER_URL.

**Status:** blocked

- [ ] Parent launch prompt references `$E_ROLE`/`$E_BROKER_URL` and role behavior
- [ ] Child launch prompt references `$E_ROLE`/`$E_BROKER_URL` and role behavior
- [ ] Neither prompt references or depends on marker files
- [ ] E2E test: parent spawns child, child sees env, child spawns sibling, parent ends with merged changes
- [ ] E2E test asserts depth cap enforced and `.env`/`.git` absent from child
