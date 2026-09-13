# 72 - secrets files: `.e/.env` written 0644 (world-readable) on the host

**Status:** Open, needs-triage.

**GitHub:** Pending - will mirror the created issue.

## Problem

The store's secret file `.e/.env` holds provider API keys, `OMNIROUTE_INITIAL_PASSWORD`, the OmniRoute endpoint `API_KEY_SECRET`, and `JWT_SECRET`. Every write path uses `fs.writeFileSync` with the default mode:

- `src/cli/init/` env seeding (random stack secrets, ticket 29)
- `src/engine/spawn/prepareLocalStack.ts:91` (`upsertEnvValue` for the OmniRoute key, ticket 33)
- `src/engine/spawn/localApiKey.ts` set-value helper

Under a normal umask (022) the file lands `0644`: readable by every local
user and process. The threat model in `docs/security/attack-surface.md`
names a **host-local compromise** as a secondary actor; a world-readable
file handing over the model keys, the dashboard password, and the JWT
secret is exactly the leakage that should not exist.

(Container-side exposure is already handled - ticket 28 whitelists which
`.e/.env` keys reach a run - but that is a different boundary than host
file permissions.)

## Scope

Write the store env file 0600 (owner-only), and do the same for any other
host-resident secret files the CLI creates (serve.json holds no secrets
today, verify none of the spool/wat files do either; keep worktree files
readable - only the env/secret files need 0600).

- One helper (e.g. `writeSecretFile` in `shared/scaffold.ts`) used by every
  `.env` / secret writer; document the invariant at the top of `dotenv.ts`
  and `scaffold.ts`.
- `e init --force` re-render path (`initPlan.ts` env write) and the
  `prepareLocalStack` / `localApiKey` writers all route through it.
- Existing files on disk: chmod-fix on access once (a user who already has a
  0644 `.e/.env` sees it tightened when `e init` or `e spawn` touches it).

## Tasks

- [ ] Add the 0600 helper and use it in every `.e/.env` write site
- [ ] Tighten an existing too-open `.e/.env` when the CLI next writes it
- [ ] Audit other secret-holding host files (config.json? broker spool? a2a spool?) for mode
- [ ] Tests: a temp-dir env write asserts mode 0600; the chmod-on-touch path covered
- [ ] Reference: `docs/security/attack-surface.md`, threat model (host-local compromise)

**Blocked by:** None - independent, low risk, can start immediately.

## Why now

Cheap hardening with a direct host-local payoff; complements the container
boundary work (tickets 28-31).
