# Tutorial 7: the web UI, browser terminal, and `e` as an A2A agent

Goal: run `e serve`, start a run from the browser, follow it on the Runs
page, hand `e` a task over the Agent2Agent protocol, and add a remote A2A
agent to the Store.

Prerequisite: one working Agent ([Tutorial 1](./01-first-run.md)).

## Step 1: start the server inside a repository

`e serve` is a backend-for-frontend over the Store and git
([ADR-0010](../adr/0010-serve-is-a-bff-observer-first-ui.md)). Runs it starts
happen in the directory it was started in, so start it inside the repository
you want agents to work on:

```bash
cd /path/to/repo
e serve --detached
open http://127.0.0.1:8080        # xdg-open on Linux
e serve stop                      # later
```

`--host` and `--port` change the bind address; the default is loopback only.

Pages:

| Page      | What it shows                                                                       |
| --------- | ----------------------------------------------------------------------------------- |
| Dashboard | Overview: server health and the Store at a glance                                   |
| Agents    | Every Agent in the Store (`/api/agents`)                                            |
| Runs      | Run history from git: every `e/*` branch with its tip, pushed or not, live siblings |
| Terminal  | Starts a run and attaches the harness TUI in the page                               |
| Egress    | Squashed egress log and the DNS blacklist ([Tutorial 8](./08-egress-blacklist.md))  |
| OmniRoute | Models the local gateway exposes (`/api/omniroute/models`)                          |
| Activity  | Event stream of what the server saw                                                 |

## Step 2: start a run from the browser

On the Terminal page pick an Agent, optionally name the run, and start. Each
session is a headless `e spawn <agent> --name <slug>` whose TUI the page
attaches to through the container engine's socket. The page tells you when it
cannot find one; it looks at `DOCKER_HOST` / `CONTAINER_HOST`, then the
platform's usual sockets ([Platform notes](../../README.md#platform-notes)).

When you quit the harness, the run ends like any other: leftover changes are
committed on `e/<agent>/<slug>-N`, pushed on exit 0 with commits, PR/MR if a
platform is configured.

## Step 3: follow runs with the API

The same data the Runs page renders:

```bash
curl -s http://127.0.0.1:8080/api/runs | jq '.runs[] | {branch, subject, pushed}'
curl -s http://127.0.0.1:8080/api/runs/e/pi/<slug>-1/logs | jq .commits
curl -s http://127.0.0.1:8080/api/runs/e/pi/<slug>-1/siblings | jq .      # live sibling records of a run with a broker
curl -N http://127.0.0.1:8080/api/runs/e/pi/<slug>-1/siblings/events    # the same as Server-Sent Events
```

## Step 4: give `e` a task over A2A

`e serve` publishes an [Agent2Agent](https://a2a-protocol.org) agent card and
speaks the A2A 1.0 JSON-RPC binding on `POST /a2a`
([ADR-0015](../adr/0015-a2a-vocabulary-facade-and-remote-agents.md)). Every
Agent in the Store is one skill on the card; a task is one run.

```bash
curl -s http://127.0.0.1:8080/.well-known/agent-card.json | jq '.skills[].id'
```

Send a task, naming the Agent in the message metadata:

```bash
curl -s http://127.0.0.1:8080/a2a -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "SendMessage",
  "params": { "message": { "messageId": "m1", "role": "ROLE_USER",
    "parts": [{ "text": "Add input validation to src/api/users.ts and cover it with tests" }],
    "metadata": { "agent": "pi-anthropic" } } } }' | jq .
# {"result":{"task":{"id":"<taskId>","status":{"state":"TASK_STATE_SUBMITTED"}, ...}}}
```

Poll it, or stream:

```bash
curl -s http://127.0.0.1:8080/a2a -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": 2, "method": "GetTask", "params": { "id": "<taskId>" } }' | jq .result.status.state

curl -N http://127.0.0.1:8080/a2a -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": 3, "method": "SubscribeToTask", "params": { "id": "<taskId>" } }'
```

Methods: `SendMessage`, `SendStreamingMessage` (send and stream in one call),
`GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`. The 0.x slash names
(`message/send`, `tasks/get`, ...) are accepted as aliases. Push notifications
are not supported; subscribe instead.

When the task reaches `TASK_STATE_COMPLETED` its one artifact carries the run
branch, whether it was pushed, and the PR/MR URL. Tasks take no follow-up
messages: put the whole task into the first one.

### Beyond loopback

The endpoint is open on `127.0.0.1` like the rest of `serve`. To expose it:

```bash
E_A2A_TOKEN=$(openssl rand -hex 24) e serve --host 0.0.0.0 --detached
```

Clients then send `Authorization: Bearer <token>`. Bound beyond loopback
without a token, the A2A endpoint stays off while the UI keeps working.

## Step 5: add a remote A2A agent to the Store

An `agent.json` with `"transport": "a2a"` names an agent hosted elsewhere. It
is selected by name like any Agent but has no Harness and no worktree; `e`
sends the prompt and prints the answer:

```bash
mkdir -p ~/.e/agents/remote-researcher
cat > ~/.e/agents/remote-researcher/agent.json <<'JSON'
{
  "name": "remote-researcher",
  "transport": "a2a",
  "url": "https://agents.example.com/a2a",
  "headers": { "Authorization": "Bearer ${RESEARCH_TOKEN}" },
  "requiredEnv": ["RESEARCH_TOKEN"],
  "description": "Answers research questions from the company wiki"
}
JSON
echo 'RESEARCH_TOKEN=...' >> ~/.e/.env

e spawn remote-researcher "Which teams own the payment service?"
```

`${VAR}` in `headers` resolves from `.e/.env` on the host at call time. The
same Agent can be requested as a sibling from inside a run
([Tutorial 6](./06-sibling-runs.md)); its answer then lands in the sibling's
report instead of on stdout.

Two `e serve` instances on different machines can therefore delegate to each
other: register machine B's `/a2a` as a remote agent in machine A's Store.
