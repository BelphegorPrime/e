# Tutorial 5: wire an MCP server into a run

Goal: run the shipped `everything` MCP server as a Sidecar, add a remote MCP
server with a token, and know which Harnesses can use them.

Prerequisite: one working Agent on `pi`, `claudeCode`, or `codex`
([Tutorial 1](./01-first-run.md)).

## Two kinds of MCP server

Each MCP server is a directory `~/.e/mcp/<name>/` with an `mcp.json`. Its
`transport` decides the mechanism; selection is always by name with
`--mcp <name>`:

| `transport` | Files                     | What `e spawn` does                                                                   |
| ----------- | ------------------------- | ------------------------------------------------------------------------------------- |
| `container` | `mcp.json` + `Dockerfile` | Builds the image, starts it as a **Sidecar** next to the run, waits for its port      |
| `remote`    | `mcp.json`                | Wires the hosted URL straight into the harness's MCP client; no container, no network |

Harness support, as `e` gates it:

| Harness      | MCP delivery                                       |
| ------------ | -------------------------------------------------- |
| `pi`         | rendered config file, through `pi-mcp-adapter`     |
| `claudeCode` | `--mcp-config` flag on the run command             |
| `codex`      | overlay merged into `config.toml`                  |
| `opencode`   | none; `--mcp` is rejected before anything is built |

## Step 1: the shipped `everything` server

`e init` seeds three container servers: `everything` (the MCP reference
server), `filesystem`, and `searxng`. Look at one:

```bash
cat ~/.e/mcp/everything/mcp.json
# { "transport": "container", "port": 3001, "requiredEnv": [] }
cat ~/.e/mcp/everything/Dockerfile
# FROM node:lts-alpine
# RUN npm install -g @modelcontextprotocol/server-everything
# EXPOSE 3001
# CMD ["mcp-server-everything", "streamableHttp"]
```

Run with it:

```bash
cd /path/to/repo
e spawn -d --mcp everything pi-anthropic "Call the MCP tool named 'echo' with the text 'hello from e' and write the reply into MCP-CHECK.md"
```

The Sidecar image is built once (`e-mcp-everything`), started before the agent, and
reached by the harness as `http://<alias-or-localhost>:<port>/mcp`. When the
local stack is running every container shares the egress network namespace,
so the server is on loopback and `e` picks a free port in `31000-31999` if
`3001` is taken; without the stack the Sidecar has its own alias on the run's
private network. The harness config is rendered per run, you never edit it.

Several servers: `--mcp everything filesystem`, or repeat the flag.

## Step 2: write a container server

Any image that serves MCP over streamable HTTP works. A stdio server can be
bridged with `supergateway`; that is how the shipped `filesystem` server is
built. Copy that shape for a server of your own:

```bash
mkdir -p ~/.e/mcp/fs-data
cat > ~/.e/mcp/fs-data/mcp.json <<'JSON'
{
  "transport": "container",
  "port": 8000,
  "requiredEnv": []
}
JSON
cat > ~/.e/mcp/fs-data/Dockerfile <<'DOCKER'
FROM node:lts-alpine
RUN npm install -g supergateway @modelcontextprotocol/server-filesystem
RUN mkdir -p /data
EXPOSE 8000
CMD ["supergateway", "--stdio", "mcp-server-filesystem /data", "--outputTransport", "streamableHttp", "--port", "8000"]
DOCKER
```

- `port` is what the server listens on inside its container; `e` probes it
  for readiness before the agent starts.
- `healthcheck` (optional, an argv array) is run inside the Sidecar with
  `<runtime> exec` and must exit 0 on top of the port being open.
- `requiredEnv` names variables from `.e/.env` the Sidecar needs (an API key
  for an upstream service, for example). They are delivered to the Sidecar
  only, never baked; a missing value fails the spawn before any container
  starts.

The image is tagged `e-mcp-<name>`. Rebuild after editing the Dockerfile with
`e spawn --rebuild ...`.

## Step 3: a remote server with a token

A hosted MCP endpoint needs no image:

```bash
mkdir -p ~/.e/mcp/company-docs
cat > ~/.e/mcp/company-docs/mcp.json <<'JSON'
{
  "transport": "remote",
  "url": "https://mcp.example.com/mcp",
  "headers": { "Authorization": "Bearer ${COMPANY_DOCS_TOKEN}" },
  "requiredEnv": ["COMPANY_DOCS_TOKEN"]
}
JSON
echo 'COMPANY_DOCS_TOKEN=...' >> ~/.e/.env
e spawn -d --mcp company-docs claude-gw "Using the company-docs MCP server, find who owns the billing service and write it to OWNERS.md"
```

`${VAR}` in `url` or `headers` is resolved by the harness at runtime from the
variables `e` injects for this run; the value is neither baked into an image
nor put on argv. A missing `requiredEnv` value fails the spawn before a
container starts.

## Debugging

- `e -v spawn --mcp ...` logs the rendered MCP config path and the Sidecar
  readiness probe.
- Keep the containers after the run to inspect them: `e spawn --no-rm ...`
  then `docker ps -a` / `docker logs <sidecar>`.
- A Sidecar that never becomes ready is usually listening on another port than
  `mcp.json` says, or serving stdio instead of streamable HTTP.
