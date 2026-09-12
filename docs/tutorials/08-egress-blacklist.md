# Tutorial 8: watch and block what agents talk to

Goal: see which domains runs resolve, block one, confirm the block from
inside a run, and lift it again.

Prerequisite: the local stack ([Tutorial 3](./03-local-models.md)). The
egress container only exists with the stack; runs without it have plain
network access.

## How it works

The stack owns one trusted container, `e-egress`, with `NET_ADMIN`, dnsmasq,
and iptables ([ADR-0011](../adr/0011-egress-blacklist-netns.md)). Every run,
MCP Sidecar, and stack service shares its network namespace, so all their DNS
goes through that dnsmasq. A blacklisted domain resolves to `0.0.0.0` / `::`;
the log of every lookup is host-visible. A small API on `127.0.0.1:20129`
reads the log and edits the blacklist ([ADR-0012](../adr/0012-egress-query-and-mutation-api.md));
`e serve` proxies it as `/api/egress/*` for the Egress page.

The blacklist source is a plain file in the Store:

```bash
cat ~/.e/egress-blacklist
```

## Step 1: see what a run resolved

Run something that reaches out:

```bash
cd /path/to/repo
e spawn pi "Search the web for the latest express release notes and summarize them in NOTES.md"
```

Then ask the egress API:

```bash
curl -s http://127.0.0.1:20129/logs/squashed | jq '.[:10]'
# [{ "domain": "registry.npmjs.org", "count": 12, "firstSeen": "...", "lastSeen": "..." }, ...]
curl -s 'http://127.0.0.1:20129/logs?domain=github.com&limit=20' | jq .
```

Localhost and stack-internal names are dropped from the view; what you see is
outbound traffic. The Egress page in `e serve` renders the same squashed list.

## Step 2: block a domain

```bash
curl -s -X POST http://127.0.0.1:20129/blacklist/domains \
  -H 'content-type: application/json' -d '{"domain":"example.com"}'
curl -s http://127.0.0.1:20129/blacklist/domains
# {"domains":["example.com"]}
```

The API appends `address=/example.com/0.0.0.0` and `address=/example.com/::`
to the mounted blacklist file and restarts dnsmasq inside the container; the
block applies within about a second, without recreating the namespace or
restarting any run. Domains are validated as DNS names before they are
written; anything else is rejected with `400`.

Editing `~/.e/egress-blacklist` by hand works too. Reload afterwards:

```bash
docker kill -s HUP e-egress
```

## Step 3: confirm it from inside a run

```bash
e spawn pi
# in pi's shell:
getent hosts example.com        # 0.0.0.0 example.com
curl -sS https://example.com    # fails to connect
```

Blocked lookups show up in the log with their action, so the squashed view
also tells you which run kept trying.

## Step 4: unblock

```bash
curl -s -X DELETE http://127.0.0.1:20129/blacklist/domains/example.com
```

## What this is and is not

- It is a DNS-level, allow-by-default blacklist for everything inside the
  stack's namespace: runs, Sidecars, and the gateway alike.
- It is not an allowlist and not a proxy; a run that connects to a raw IP is
  not stopped by dnsmasq. The iptables rules the egress container applies are
  in `~/.e/egress-iptables.rules` (rendered from `iptables.example`), where
  you can tighten that.
- The threat model and the remaining gaps are written up in
  [docs/security/attack-surface.md](../security/attack-surface.md).
