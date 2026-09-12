# Tutorial 2: Agents for every Harness on a hosted Provider

Goal: define Agents for pi, Claude Code, and Codex that all talk to hosted
endpoints, understand how each Harness receives its Provider, and rebuild an
Agent after changing it.

Prerequisite: [Tutorial 1](./01-first-run.md) (a Store exists).

## The Provider contract

Every `agent.json` Provider has the same four fields:

```json
{
  "baseUrl": "https://gateway.example.com",
  "model": "claude-sonnet-4-5",
  "protocol": "anthropic-messages",
  "apiKeyEnv": "MY_GATEWAY_KEY"
}
```

- `protocol` is the wire protocol the endpoint speaks. `e` knows three:
  `anthropic-messages`, `openai-chat`, `openai-responses`. The Harness must
  speak it too, or `e spawn` refuses the Agent before building anything.
- `apiKeyEnv` is the **name** of a variable in `.e/.env`. Put the value there:

```bash
echo 'MY_GATEWAY_KEY=sk-...' >> ~/.e/.env
```

- `model` is a concrete id, or `auto` / `auto/coding`, which the harness
  resolves at run start against the endpoint's `/v1/models`
  ([ADR-0007](../adr/0007-auto-model-delivery.md)). Use a concrete id for a
  first run so a failure is about the endpoint, not model resolution.

## What each Harness speaks and how it is configured

| Harness      | Protocols                                               | Provider delivery                                                                          | MCP |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --- |
| `pi`         | `openai-chat`, `openai-responses`, `anthropic-messages` | `models.json` baked into the derived image; the key **value** is baked too (pi needs it)   | yes |
| `claudeCode` | `anthropic-messages`                                    | env vars at runtime; the key is injected by name, never baked                              | yes |
| `codex`      | `openai-responses`                                      | `config.toml` baked into the derived image; the key is referenced by env name, never baked | yes |
| `opencode`   | `openai-chat`, `openai-responses`, `anthropic-messages` | none: no Provider delivery yet, the image runs against the ambient env only                | no  |

Two consequences:

- Editing a pi or Codex Agent's Provider changes a **baked** file, so the next
  spawn needs `--rebuild`. A Claude Code Agent picks the change up on the next
  run without a rebuild.
- An `agent.json` for `opencode` with a `provider` block is rejected
  ("has no config adapter"). Run opencode as the bare harness name.

## Three Agents, one gateway

Assume an OpenAI-compatible gateway at `https://gw.example.com/v1` that also
exposes the Anthropic Messages API at `https://gw.example.com`, and the key in
`MY_GATEWAY_KEY`.

```bash
mkdir -p ~/.e/agents/{pi-gw,claude-gw,codex-gw}

cat > ~/.e/agents/pi-gw/agent.json <<'JSON'
{
  "name": "pi-gw",
  "harness": "pi",
  "provider": {
    "baseUrl": "https://gw.example.com/v1",
    "model": "claude-sonnet-4-5",
    "protocol": "openai-chat",
    "apiKeyEnv": "MY_GATEWAY_KEY"
  }
}
JSON

cat > ~/.e/agents/claude-gw/agent.json <<'JSON'
{
  "name": "claude-gw",
  "harness": "claudeCode",
  "provider": {
    "baseUrl": "https://gw.example.com",
    "model": "claude-sonnet-4-5",
    "protocol": "anthropic-messages",
    "apiKeyEnv": "MY_GATEWAY_KEY"
  }
}
JSON

cat > ~/.e/agents/codex-gw/agent.json <<'JSON'
{
  "name": "codex-gw",
  "harness": "codex",
  "provider": {
    "baseUrl": "https://gw.example.com/v1",
    "model": "gpt-5",
    "protocol": "openai-responses",
    "apiKeyEnv": "MY_GATEWAY_KEY"
  }
}
JSON
```

Use the base URL form your endpoint documents for that protocol; pi and Codex
take it verbatim into their config files.

Try each one:

```bash
cd /path/to/repo
e spawn -d pi-gw "Print the git remote URL and exit"
e spawn -d claude-gw "Print the git remote URL and exit"
e spawn -d codex-gw "Print the git remote URL and exit"
```

The first spawn per Harness builds its base image; each Agent then gets a
derived image named `e-agent-<name>`.

## Verify what was delivered

The rendered files live next to the Agent, so you can read them without
opening a container:

```bash
cat ~/.e/agents/pi-gw/models.json      # pi: provider "e", your model, the key value
cat ~/.e/agents/pi-gw/Dockerfile       # FROM the pi base image, COPY models.json
cat ~/.e/agents/codex-gw/config.toml   # codex: model_provider "e", env_key = "MY_GATEWAY_KEY"
```

For Claude Code there is no file: the Provider becomes env vars on the run
command. The README's [rendering checks](../../README.md#2-rendering-checks-no-container-no-gateway)
show how to print what an adapter renders from the compiled modules.

## Change a Provider and rebuild

Switch `pi-gw` to another model:

```bash
sed -i 's/"model": "claude-sonnet-4-5"/"model": "claude-opus-5"/' ~/.e/agents/pi-gw/agent.json
e spawn -d --rebuild pi-gw "Which model are you? Answer in one line and exit"
```

Without `--rebuild` the old `models.json` stays baked in the derived image and
pi keeps using the previous model.

## Bake Skills into an Agent

An Agent can carry default Skills that every run gets:

```json
{
  "name": "pi-gw",
  "harness": "pi",
  "provider": { "...": "..." },
  "skills": ["web-search", "conventional-commits"]
}
```

Each name is a directory under `~/.e/skills/`. [Tutorial 4](./04-skills.md)
covers writing your own.

## Multiple Stores

`e init --dir <path>` writes `<path>/.e`, and `e spawn --dir <path>` uses it.
Without `--dir`, `e` walks up from the current directory to the nearest `.e`
and falls back to `~/.e`, so a Store inside a project wins over the machine
Store when you spawn from that project. [Tutorial 9](./09-stores-export-import.md)
has the details.
