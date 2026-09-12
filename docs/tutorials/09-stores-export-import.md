# Tutorial 9: several Stores, and moving one to another machine

Goal: keep a per-project Store next to the machine Store, and carry a
configured Store (Agents, gateway state, secrets) to a second machine.

Prerequisite: [Tutorial 1](./01-first-run.md).

## How `e` finds its Store

Every command resolves the Store root in this order:

1. `--dir <path>` (`e init --dir`, `e spawn --dir`, `e import --dir`).
2. The nearest ancestor of the current directory that contains a `.e`.
3. `~/.e`.

So a Store inside a project is picked up automatically when you work in that
project, and `~/.e` serves everything else.

## A per-project Store

Useful when a project needs its own Agents, Skills, or a different git
platform, and you want all of that versioned with the project:

```bash
cd /path/to/infra-repo
e init                    # accept the default installation directory: ./.e
ls .e
```

Add a project-specific Agent and Skill under `.e/agents/` and `.e/skills/`.
Commit `.e/` except the secrets and the rendered per-agent files:

```gitignore
.e/.env
.e/.env.bak
.e/agents/*/models.json
.e/agents/*/config.toml
.e/agents/*/Dockerfile
.e/*.zip
```

pi's `models.json` contains the key **value** ([Tutorial 2](./02-hosted-provider.md)),
which is why it must stay out of git. Teammates run `e init --yes` once in
the checkout to get their own `.env`, then `e spawn` from anywhere inside the
repository uses this Store.

Spawn against a Store from elsewhere with `--dir`:

```bash
e spawn --dir /path/to/infra-repo pi "Bump the base images"
```

## Export a Store

`e export` zips the host-only state and the OmniRoute volume:

- `.env` (secrets: keys, the OmniRoute initial password, JWT and API secrets)
- `config.json`, `compose.yaml`, `bootstrap.sh`
- the `omniroute-data` volume (providers, endpoint keys, routing)

```bash
e export -o ~/e-state.zip
```

The stack's volume must exist, so run this on a machine where the stack has
been up at least once. **The archive contains your secrets in clear text**;
treat it like the `.env` it contains.

Agents, Skills, and MCP servers are plain directories under `.e/` and are not
in the archive. Copy them alongside:

```bash
tar -C ~/.e -czf ~/e-defs.tgz agents skills mcp
```

## Import on the other machine

```bash
e init --yes                        # a fresh Store with Dockerfiles for this machine's hardware
e import ~/e-state.zip              # into the nearest .e store, or --dir <path>
tar -C ~/.e -xzf ~/e-defs.tgz
docker compose -f ~/.e/compose.yaml --env-file ~/.e/.env up -d
```

`e import` refuses to overwrite an existing configuration unless you pass
`--force`. Run `e init` again afterwards if the new machine has a different
GPU: the compose file in the archive was rendered for the old one, and the
wizard keeps every value you imported.

Images are not part of the move; the first `e spawn` per Harness and Agent
rebuilds them. Model weights are not either; download them again
([Tutorial 3](./03-local-models.md)).
