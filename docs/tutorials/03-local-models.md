# Tutorial 3: run agents on local models

Goal: bring up the local stack (OmniRoute gateway plus a local inference
runtime), download a model, and run the default Agents against it. No hosted
key needed.

Prerequisite: `e` installed, a container engine with Compose v2
([Install](../../README.md#install)). Docker and Podman are the well-trodden
paths; nerdctl and Finch have less complete Compose implementations.

## The pieces

| Service                   | Role                                                                   | Host port                   |
| ------------------------- | ---------------------------------------------------------------------- | --------------------------- |
| `e-egress`                | Trusted network namespace every run and Sidecar joins; DNS blacklist   | `127.0.0.1:20129` (its API) |
| OmniRoute                 | Model gateway; the default Agents point at it with model `auto/coding` | `127.0.0.1:20128`           |
| Redis                     | OmniRoute's state                                                      | internal                    |
| Searxng                   | Web search behind the shipped `web-search` Skill                       | internal                    |
| llama.cpp / Ollama / vLLM | The inference runtime(s) you select in `e init`                        | internal                    |

All host ports bind to loopback. `e spawn` runs `compose up -d` on the stack
before every run when the Store has a `compose.yaml`, so you rarely start it
by hand.

## Step 1: select a runtime in `e init`

Re-run the wizard (it keeps your existing answers and `.env`) and pick one or
more runtimes at the "Local AI runtimes" question. With llama.cpp selected it
also asks which models from its catalog to provision; `e init` detects your GPU
vendor (NVIDIA, AMD ROCm, Intel; CPU on macOS) and renders the matching
llama.cpp image and device passthrough.

```bash
cd ~
e init
```

Look at what it rendered:

```bash
head -20 ~/.e/compose.yaml      # the header names the runtime and the detected hardware
cat ~/.e/config.json            # "localRuntimes": ["llamacpp"], "models": [...]
```

## Step 2: start the stack and download a model

Start it once by hand so you can watch the logs:

```bash
docker compose -f ~/.e/compose.yaml --env-file ~/.e/.env up -d
docker compose -f ~/.e/compose.yaml ps
```

Then pull weights. Model downloads are deliberately not part of `e init`;
each runtime has its own command:

```bash
e llamacpp download unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M   # registers the model with llama.cpp, which starts fetching it
e ollama download qwen3:4b                               # `ollama pull` inside the ollama container
e vllm download Qwen/Qwen2.5-7B-Instruct                 # vLLM pulls on first request; this only reminds you
```

Progress shows in the runtime's container logs:

```bash
docker logs -f llama          # or: ollama, vllm
```

## Step 3: open OmniRoute

The gateway dashboard is at <http://127.0.0.1:20128>. The initial password is
the `OMNIROUTE_INITIAL_PASSWORD` value in `~/.e/.env`:

```bash
grep OMNIROUTE_INITIAL_PASSWORD ~/.e/.env
```

`bootstrap.sh` registered the selected local runtime as a provider. In the
dashboard you can add hosted providers next to it and set up routing, so one
Agent pointed at OmniRoute can fall back from a local model to a hosted one.
Create an **API key** for the endpoint while you are there; the next step asks
for it.

## Step 4: run a default Agent

The default Agents `e init` wrote (`~/.e/agents/pi/agent.json` and friends)
already point at the gateway:

```json
{
  "name": "pi",
  "harness": "pi",
  "provider": {
    "baseUrl": "http://localhost:20128/v1",
    "baseUrlEnv": "OPENAI_BASE_URL",
    "model": "auto/coding",
    "protocol": "openai-chat",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "skills": ["web-search"]
}
```

`auto/coding` is resolved at run start against the gateway's `/v1/models`
([ADR-0007](../adr/0007-auto-model-delivery.md)), so the Agent follows whatever
you route in OmniRoute without a rebuild.

```bash
cd /path/to/repo
e spawn pi "Add a README section that lists the npm scripts and what each does"
```

On the first spawn against a fresh stack `e` notices that `OPENAI_API_KEY` is
empty or still the initial password and asks:

```text
OmniRoute API key:
```

Paste the endpoint key from the dashboard. `e` writes it into `~/.e/.env`
under the Agent's `apiKeyEnv` and continues; hosted Agents are never asked.

Inside the container the run shares the egress network namespace, so the
harness reaches OmniRoute on `localhost:20128` and Searxng on
`localhost:8080`, while it cannot reach the stack by its Compose service
names.

## Step 5: check which model answered

```bash
curl -s -H "Authorization: Bearer $(grep ^OPENAI_API_KEY ~/.e/.env | cut -d= -f2)" \
  http://127.0.0.1:20128/v1/models | jq '.data[].id'
```

The OmniRoute dashboard's activity view shows every request a run made and
which provider served it.

## Stopping and resetting

```bash
docker compose -f ~/.e/compose.yaml stop          # keep volumes (models, OmniRoute state)
docker compose -f ~/.e/compose.yaml down -v       # wipe everything, including downloaded models
```

Downloaded weights live in the runtime's volume; OmniRoute's providers, keys,
and routing live in the `omniroute-data` volume, which `e export` packs up
([Tutorial 9](./09-stores-export-import.md)).

## Without a GPU

Everything runs on the CPU; pick a small model (`qwen3:4b` on Ollama, a
4-bit GGUF on llama.cpp). On macOS no engine passes the GPU through, so for
Metal acceleration run Ollama or llama.cpp natively on the host and add it in
OmniRoute as a provider at `http://host.docker.internal:<port>` (Docker
Desktop, OrbStack) instead of selecting a runtime in `e init`.
