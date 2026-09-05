#!/usr/bin/env bash
# Create Q4a + Q4b-1 in BelphegorPrime/e, wire the blocked_by edge.
# Run from a checkout of the host repo (gh infers the repo from git remote).
set -eu

REPO="BelphegorPrime/e"

Q4A_BODY=$(cat <<'EOF'
## Problem

`executeSpawn.ts` composes the run's env-files starting from the store's
`baseEnvFile` (`.e/.env`), and the **whole file** is passed to every agent
container. Any secret a user keeps in `.e/.env` — not just the keys the run's
provider and MCP servers declare — is visible to the untrusted harness agent.

## Scope

Filter the base env-file before it reaches a container. Allowed keys:

- the run's provider `apiKeyEnv` and `baseUrlEnv`
- `requiredEnv` of the run's sidecar and remote MCP servers
- the global `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` template lines

Unknown keys stay in `.e/.env` (readable by the user's own shell) but never
enter a container.

## Tasks

- [ ] Add the whitelist filter to the env-file composition (spawnPlan or executeSpawn)
- [ ] Update `executeSpawn.ts` to apply the filter to `baseEnvFile` before `orderEnvFiles`
- [ ] Keep per-harness template sections unchanged (separate channel via the config adapter)
- [ ] Tests: `runSpawn.test.ts` / `harness/adapter.test.ts` — assert filtered-in vs. filtered-out keys
- [ ] Reference: `docs/security/attack-surface.md`, Zone 2

## Why now

Q4b-1 (randomized OmniRoute stack secrets in `.e/.env`) is blocked on this:
the stack secrets must not reach a container until injection is filtered.
EOF
)

echo "==> Creating Q4a (env injection whitelist)"
Q4A_URL=$(gh issue create --repo "$REPO" \
  --title ".e/.env injection: filter to declared provider + MCP keys (whitelist)" \
  --body "$Q4A_BODY" \
  --label "ready-for-agent")
Q4A=$(printf '%s' "$Q4A_URL" | sed -n 's|.*/issues/\([0-9]*\).*|\1|p')
echo "    Q4a = #$Q4A"

Q4B1_BODY=$(cat <<EOF
## Problem

The local compose stack binds OmniRoute to \`0.0.0.0:20128\` with hardcoded
default secrets (\`renderCompose.ts\`):

- \`INITIAL_PASSWORD=\${OMNIROUTE_INITIAL_PASSWORD:-local-development}\`
- \`JWT_SECRET=\${JWT_SECRET:-local-development-jwt-secret-32-bytes}\`
- \`API_KEY_SECRET=\${API_KEY_SECRET:-local-development-api-key-secret-32-bytes}\`

On an untrusted LAN any machine can open the dashboard and log in with the
well-known default password.

## Scope

1. Bind the OmniRoute port to \`127.0.0.1:20128:20128\` in \`renderCompose.ts\`.
2. \`e init\` generates fresh random \`OMNIROUTE_INITIAL_PASSWORD\`, \`JWT_SECRET\`,
   \`API_KEY_SECRET\` into \`.e/.env\` (only when absent, so a re-init never
   rotates a value the user already set).
3. Remove the \`:-local-development\` fallbacks from the compose template.
4. Update the hardcoded \`local-development\` references in \`spawn.ts\`
   (prompt text ~line 101, accepted-key check ~line 308) to read the
   generated password from the store env.

## Blocked by

- #$Q4A (env injection whitelist): the stack secrets must not reach a
  container until \`.e/.env\` injection is filtered.

## Tasks

- [ ] Port bind: \`127.0.0.1:20128:20128\`
- [ ] Secret seeding in \`init.ts\` (randomBytes; preserve existing values)
- [ ] Remove hardcoded compose defaults
- [ ] \`spawn.ts\` prompt + key check read \`OMNIROUTE_INITIAL_PASSWORD\`
- [ ] Tests: renderCompose port + no-default assertion; init seeding test
- [ ] Reference: \`docs/security/attack-surface.md\`, Zone 3
EOF
)

echo "==> Creating Q4b-1 (OmniRoute bind + randomized stack secrets)"
Q4B1_URL=$(gh issue create --repo "$REPO" \
  --title "OmniRoute: bind 127.0.0.1, generate stack secrets at e init (drop local-development defaults)" \
  --body "$Q4B1_BODY" \
  --label "ready-for-agent")
Q4B1=$(printf '%s' "$Q4B1_URL" | sed -n 's|.*/issues/\([0-9]*\).*|\1|p')
echo "    Q4b-1 = #$Q4B1"

echo "==> Wiring dependency edge Q4b-1 blocked_by Q4a"
Q4A_DB_ID=$(gh api "repos/$REPO/issues/$Q4A" --jq .id)
gh api --method POST "repos/$REPO/issues/$Q4B1/dependencies/blocked_by" \
  -F "issue_id=$Q4A_DB_ID" >/dev/null
echo "    edge set: #$Q4B1 blocked_by #$Q4A (db-id $Q4A_DB_ID)"

echo
echo "Done. Q4a=#$Q4A  Q4b-1=#$Q4B1"