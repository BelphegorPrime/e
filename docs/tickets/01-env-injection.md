# 01 - Env injection: E_ROLE and E_BROKER_URL

**Shipped 2026-09-12.** Implemented in `src/runs/runRole.ts` (the contract:
names, `parseRunRole`, `brokerUrl`, `roleEnv`, `runRoleInstructions`),
injected by `planSpawn` as the last `-e` entries of `agentEnv` (host wins over
a user `-e` and over every env-file), named in the one-shot launch prompt by
`runSpawn`'s `launchPrompt`. The `e spawn` process takes the role it hands out
from the internal `E_SPAWN_ROLE` marker (`Env.spawnRole`, the same shape as
`E_TTY_HEADLESS`); unset means `parent`. A user `-e` on either contract key is
refused by `validateSpawn`. Conventions the
later tickets build on: broker alias `runtime-broker`, port `20130`;
`E_BROKER_URL` is `http://runtime-broker:20130` on a private run network and
`http://localhost:20130` in the shared `e-egress` namespace, without a trailing
slash. Until ticket 02 ships, nothing listens there.

**What to build:** Every container started in a run (parent or child) receives `E_ROLE` (`parent` | `child`) and `E_BROKER_URL` via host-set env (envFile / `RunOptions.env`), never baked into an image. Roles stay a runtime concept; no marker files live in any worktree.

**Blocked by:** None - can start immediately.

**Status:** done

- [x] Parent container launched with `E_ROLE=parent` and `E_BROKER_URL=<host>:<port>`
- [x] Child container launched with `E_ROLE=child` and `E_BROKER_URL=<host>:<port>`
- [x] Values come from host-set env (envFile or `RunOptions.env`), not from image layers
- [x] AGENTS.md and launch prompts tell agents to check `$E_ROLE` / `$E_BROKER_URL` and not create marker files
