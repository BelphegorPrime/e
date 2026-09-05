#!/usr/bin/env sh
# Create the Q3 + Q5 implementation-rest issues anchored by ADR-0010.
# Run from a checkout of the host repo (gh infers the repo from git remote).
set -eu

REPO="BelphegorPrime/e"

Q3_BODY=$(cat <<'EOF'
## Context

ADR-0010 (`docs/adr/0010-serve-is-a-bff-observer-first-ui.md`) decides the
OmniRoute dashboard key prompt stays inline in `e spawn` — no `e login`
command.

## Work

Today the prompt already lives inline in `spawn.ts` (creates an API key via the
OmniRoute dashboard, writes it into `.e/.env`). This issue is the
implementation rest: with issue #25 (stack secrets randomized),
`local-development` is no longer the sign-in password, so:

- [ ] Update the sign-in instructions (currently "Sign in with the local
      password: local-development") to read the generated password from the
      store env.
- [ ] Keep the flow inline in `spawn`; do not add an `e login` command.
- [ ] Tests: prompt text reflects the store's password; key accepted check
      matches it.

## Blocked by

- #25 (OmniRoute stack secrets) — the instructions only change once the
  password is randomized. No edge needed.
EOF
)

Q5_BODY=$(cat <<'EOF'
## Context

ADR-0010 decides the runs index (`/api/runs/*`) is branch-backed:
`refs/heads/run/*` per ADR-0003, until the UI needs live timing or streaming
logs.

## Work

- [ ] Implement `/api/runs/*` over git branches (list, per-run status, logs).
- [ ] Wire it behind `serve`'s `/api` root next to `/api/info`.
- [ ] Deliberately do **not** build live log/timing views yet; the namespace
      stays extensible.
- [ ] (Q1 rest) The observer-first, read-only UI contract: no write endpoints,
      no session/auth (local-only, `127.0.0.1` bind).

## Blocked by

- (none) — independent; the UI is a stub today, so this lands as `serve`
  grows into the BFF.
EOF
)

echo "==> Creating Q3 (key prompt inline, password-driven)"
Q3_URL=$(gh issue create --repo "$REPO" \
  --title "spawn: keep inline OmniRoute key prompt, drive sign-in password from store env" \
  --body "$Q3_BODY" \
  --label "ready-for-agent")
Q3=$(printf '%s' "$Q3_URL" | sed -n 's|.*/issues/\([0-9]*\).*|\1|p')
echo "    Q3 = #$Q3"

echo "==> Creating Q5 (branch-backed runs index)"
Q5_URL=$(gh issue create --repo "$REPO" \
  --title "serve: branch-backed /api/runs/* index + observer-first read-only UI" \
  --body "$Q5_BODY" \
  --label "ready-for-agent")
Q5=$(printf '%s' "$Q5_URL" | sed -n 's|.*/issues/\([0-9]*\).*|\1|p')
echo "    Q5 = #$Q5"

echo
echo "Done. Q3=#$Q3  Q5=#$Q5"