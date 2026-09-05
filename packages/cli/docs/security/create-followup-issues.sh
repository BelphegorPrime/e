#!/usr/bin/env sh
# Create the remaining security follow-ups in BelphegorPrime/e:
# Q4b-2 (non-root container), Q4b-3 (egress), serve.json stale-pid (minor).
# Run from a checkout of the host repo (gh infers the repo from git remote).
set -eu

REPO="BelphegorPrime/e"

Q4B2_BODY=$(cat <<'EOF'
## Problem

The harness Dockerfile template (`harness/renderDockerfile.ts`) has no `USER`
directive — every agent container runs as **root** with full capabilities. A
prompt-injected or compromised harness agent therefore gets root inside the
run container (no host sockets are mounted, so the blast radius is contained,
but root amplifies any future escape class).

## Scope

A non-root runtime user in the shared Dockerfile template, per-harness
overridable:

- Add a `USER` (non-root) to `renderDockerfile.ts`; `node:lts-alpine` ships a
  `node` user, so a `USER node` line plus a writable home is the baseline.
- Some harness CLIs write to their config/home dirs at runtime; decide per
  harness whether root is required and carry that as a template parameter /
  per-harness override (the harness registry owns the decision).
- Verify the run worktree bind-mount stays writable by the non-root uid
  (host uid vs. container uid mapping is the crux — the worktree is host-owned).

## Tasks

- [ ] `USER` + writable home in `renderDockerfile.ts` (default non-root)
- [ ] Per-harness override in the registry for harnesses that need root
- [ ] Verify worktree bind-mount permissions for the run uid
- [ ] Tests: renderDockerfile emits `USER`; per-harness overrides
- [ ] Reference: `docs/security/attack-surface.md`, Zone 1, item 3

## Blocked by

- (none) — independent of #24/#25.
EOF
)

Q4B3_BODY=$(cat <<'EOF'
## Problem

Agent containers have full network egress (ADR-0002 accepted this as a
deferred gap). The harness agent only *needs* to reach its provider base URL
and the configured MCP endpoints; everything else is reachable anyway.

## Scope

Egress hardening for the run group:

- Docker has no native per-container egress firewall; options are a proxy
  container on the run network (allow-list of host:port) or a network-policy
  layer where the runtime supports it (compose network driver, CNI).
- The allow-list derives from the planned provider base URL
  (`provider.baseUrlEnv`) plus the run's sidecar/remote MCP endpoints.
- Must not break the local compose stack (OmniRoute/llama on
  `host.docker.internal`) or sidecar-to-sidecar traffic.

## Tasks

- [ ] Design decision: proxy container vs. network policy
- [ ] Derive the allow-list from the spawn plan
- [ ] Wire into the run network setup (ADR-0005 groups)
- [ ] Tests: egress allow-list matches provider + MCP endpoints
- [ ] Reference: `docs/security/attack-surface.md`, Zone 1, item 4

## Blocked by

- (none) — independent; lowest urgency of the security follow-ups.
EOF
)

SERVE_BODY=$(cat <<'EOF'
## Problem

`s` detached mode (`E_SERVE_DETACHED`) writes a pid/host/port to
`serve.json`; on re-invocation it reports "already serving". After a host
reboot the pid is stale but the file persists — the client may think the UI
is up when it is not.

## Scope

Verify (and fix if needed) stale-detection:

- Check `serve.json` owner pid is alive before reporting "already serving".
- Health-probe the recorded host:port as an alternative / in addition.
- Clear the state file when the server is stopped or found dead.

## Tasks

- [ ] Stale-pid detection on re-invocation
- [ ] Tests: stale entry falls through to starting a fresh server
- [ ] Reference: `docs/security/attack-surface.md`, Zone 4, item 5

## Blocked by

- (none) — minor cleanup.
EOF
)

echo "==> Creating Q4b-2 (non-root container)"
Q4B2_URL=$(gh issue create --repo "$REPO" \
  --title "Harness containers: non-root runtime user, per-harness override" \
  --body "$Q4B2_BODY" \
  --label "ready-for-agent")
Q4B2=$(printf '%s' "$Q4B2_URL" | sed -n 's|.*/issues/\([0-9]*\).*|\1|p')
echo "    Q4b-2 = #$Q4B2"

echo "==> Creating Q4b-3 (egress hardening)"
Q4B3_URL=$(gh issue create --repo "$REPO" \
  --title "Egress hardening: allow-list provider + MCP endpoints for run containers" \
  --body "$Q4B3_BODY" \
  --label "ready-for-agent")
Q4B3=$(printf '%s' "$Q4B3_URL" | sed -n 's|.*/issues/\([0-9]*\).*|\1|p')
echo "    Q4b-3 = #$Q4B3"

echo "==> Creating serve.json stale-pid"
SERVE_URL=$(gh issue create --repo "$REPO" \
  --title "serve: detect stale detached pid in serve.json (host reboot)" \
  --body "$SERVE_BODY" \
  --label "ready-for-agent")
SERVE=$(printf '%s' "$SERVE_URL" | sed -n 's|.*/issues/\([0-9]*\).*|\1|p')
echo "    serve.json = #$SERVE"

echo
echo "Done. Q4b-2=#$Q4B2  Q4b-3=#$Q4B3  serve=#$SERVE"