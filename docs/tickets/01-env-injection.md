# 01 - Env injection: E_ROLE and E_BROKER_URL

**What to build:** Every container started in a run (parent or child) receives `E_ROLE` (`parent` | `child`) and `E_BROKER_URL` via host-set env (envFile / `RunOptions.env`), never baked into an image. Roles stay a runtime concept; no marker files live in any worktree.

**Blocked by:** None - can start immediately.

**Status:** ready-for-agent

- [ ] Parent container launched with `E_ROLE=parent` and `E_BROKER_URL=<host>:<port>`
- [ ] Child container launched with `E_ROLE=child` and `E_BROKER_URL=<host>:<port>`
- [ ] Values come from host-set env (envFile or `RunOptions.env`), not from image layers
- [ ] AGENTS.md and launch prompts tell agents to check `$E_ROLE` / `$E_BROKER_URL` and not create marker files
