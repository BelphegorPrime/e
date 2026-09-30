# Traced end-to-end runs of `e`

`scripts/e2e/e2e.mjs` (`npm run e2e -- ...`) runs the real, freshly built `e`
CLI against a disposable **sandbox** and writes a **trace** of every step: what
`e` printed, what the container engine did, what the harness asked the model,
and what git looks like afterwards. Use it to prove a feature works end to end,
the level above `npm test` and the fake runtimes in `runSpawn.e2e.test.ts`.

```bash
node scripts/e2e/e2e.mjs new demo                      # sandbox, stub model
node scripts/e2e/e2e.mjs run demo --turns '[{"tool":"bash","args":{"command":"echo hi > hi.txt"}}]' \
  -- spawn e2e-pi "write hi.txt"                       # traced step; prints summary.md
node scripts/e2e/e2e.mjs report demo                   # every step's summary
node scripts/e2e/e2e.mjs clean demo [--images]         # remove it (and e-agent-e2e-* images)
```

Everything after `--` is passed to `e` verbatim. `run` rebuilds `dist/` first
when `src/` is newer (`--no-build` skips, `--build` forces), so a trace always
runs the code in the tree.

## The sandbox

`.e2e/<name>/` (gitignored), created by `new`:

| Path              | What                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.e/`             | The Store, rendered by the CLI under test (`e init -y --dir`), minus `compose.yaml`, `localRuntimes` and `gitPlatform`: no local stack, no PR, no prompts. |
| `.e/agents/e2e-*` | `e2e-pi`, `e2e-codex`, `e2e-opencode`, `e2e-claude`, all pointing at the sandbox's model endpoint.                                                         |
| `repo/`           | The git repo `e` runs in (`main`, one seed commit). The cwd of every step unless `--cwd`.                                                                  |
| `origin.git/`     | Bare remote of `repo/`: what a run pushed shows up in `git ls-remote`.                                                                                     |
| `worktrees/`      | `E_WORKTREES_DIR` for every step; broker spools live under `worktrees/.broker/`.                                                                           |
| `steps/NN-<cmd>/` | One trace per `run`.                                                                                                                                       |

Image tags are global to the engine (`e-agent-<name>`, `e-harness-<harness>`),
which is why sandbox agents are named `e2e-*`: a sandbox agent called `pi`
would overwrite the user's `e-agent-pi`. Harness base images are shared and
rebuilt from the sandbox's Dockerfiles; the first run after a Dockerfile
change takes minutes, later ones hit the layer cache.

## Model: stub or live

`new --model stub` (default) serves a **script** from
`scripts/e2e/stub-model.mjs`, OpenAI chat-completions (pi, opencode), OpenAI
Responses (Codex) and Anthropic messages (Claude Code), streamed or not, on the docker bridge gateway (`172.17.0.1:<port>`, reachable
from run containers and private run networks, not from the LAN). The script is
`--script file.json` or inline `--turns '<json>'`:

```jsonc
{
  "turns": [
    { "task": "PARENT", "tool": "bash", "args": { "command": "..." } }, // one tool call
    { "task": "SIBLING", "tools": [{ "tool": "write", "args": {} }] }, // several
    { "match": "exit code 0", "text": "all good" }, // plain answer
  ],
  "final": "done", // once no turn fits
}
```

Each request gets the first unused turn it is eligible for. `task` filters on
the conversation's user messages (the run's prompt), `match` on the newest
user/tool input. Put a unique token in each run's prompt and tag its turns
with it whenever more than one conversation hits the stub (siblings, fusion
candidates, verify loops). Tool names and arguments are the harness's own:

| Agent          | Shell tool call                                                |
| -------------- | -------------------------------------------------------------- |
| `e2e-pi`       | `{"tool":"bash","args":{"command":"..."}}`                     |
| `e2e-codex`    | `{"tool":"exec_command","args":{"cmd":"..."}}`                 |
| `e2e-claude`   | `{"tool":"Bash","args":{"command":"...","description":"..."}}` |
| `e2e-opencode` | `{"tool":"bash","args":{"command":"...","description":"..."}}` |

Any step's `model.jsonl` holds the full tool list a harness sent. A tool-call
turn is served only to a request that offers that tool. A request that offers
no tools at all is a harness's side request (opencode and Claude Code title
the session first): it gets `aux` (default `"e2e"`) and uses no turn, unless a
turn is marked `"aux": true` for it.

`new --model live` makes the same endpoint a recording proxy to the local
OmniRoute (`$OMNIROUTE_URL`, default `http://127.0.0.1:20128`, model
`auto/coding` or `--live-model`), with `OPENAI_API_KEY` from `~/.e/.env`. Real
model, slow and nondeterministic, every request and reply still logged.

## Reading a trace

Start with `summary.md` (also printed by `run`): exit code, engine commands,
errors, output tail, containers with exit codes, networks, images, one line per
model request, git graph, new branches with diff stats, origin refs, leaks.
Then drill in:

| File                  | Answers                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `combined.log`        | What `e` printed, stdout and stderr interleaved, `[+seconds] [out/err]`. `VERBOSE=true`. |
| `tui/`, `tty.raw`     | TUI steps only: the keys journal, screen snapshots, `final.txt`, the raw pty stream.     |
| `commands.txt`        | Full argv of every `> docker ...` line `e` logged (secret `-e` values masked).           |
| `docker-events.jsonl` | Every engine event during the step.                                                      |
| `containers/<name>.*` | `inspect.json` at create (secret env masked) and the container's own logs.               |
| `model.jsonl`         | Every model request (system prompt, tools, tool results) and every reply, in full.       |
| `spool/`              | Broker spools mirrored live: sibling requests, status, each sibling `e` process's log.   |
| `store/`              | The Store's `runs/`: ledger entries, harness session transcripts, repo index.            |
| `git/`                | Graph, branches, worktrees, origin refs, `checkout-status.txt`, `diffs/<branch>.diff`.   |

A step is **green** when: exit code as intended, the expected containers ran
and were removed, the model log shows the turns you scripted being served, the
new branch holds exactly the intended diff, origin has what should be pushed,
`checkout-status.txt` is empty (a run never touches the user's checkout), and
Leaks says none. Leaks covers containers, networks and volumes the step created
and left, worktrees it left, and `e-scratch-*` dirs (rendered secret files) it
left in the temp dir; a worktree `e` announced keeping ("Worktree kept at ...",
uncommitted work after a cancel) is listed as not a leak.

## Driving a TUI

`run --tui keys.json` (or inline `--tui-keys '<json>'`) runs the command under
a pseudo-terminal (`--size 120x40`), renders it with a headless xterm and
plays a keys script against the screen - `e spawn e2e-pi` with no prompt, `e
resume` without one, any interactive `e` command:

```jsonc
[
  { "wait": "escape interrupt", "stable": 3, "timeout": 300 }, // text, then 3 s without redraw
  { "send": "write tui.txt", "key": "enter" },
  { "wait": "wrote tui\\.txt", "timeout": 60 }, // regex on the visible screen
  { "snapshot": "answered" },
  { "key": "ctrl-d" }, // enter, tab, esc, up, ..., ctrl-<letter>
  { "exit": 60 },
]
```

- Wait for what the TUI draws, never for `e`'s own log lines: the
  `docker run` line printed before the TUI starts already contains
  `/workspace`.
- `stable` is the readiness check: pi shows its prompt while still
  downloading `fd`/`ripgrep` and answers "Startup is still in progress" to
  input sent then.
- Input is paced (`--tui-pace`, 250 ms after each send/key): text and Enter
  in one burst read as a paste, and the Enter becomes a newline.
- A failed `wait`/`exit` snapshots the screen (`*-FAILED.txt`) and ends the
  command: Ctrl-C, then SIGTERM (the pty hangs up and `e` tears the run
  down), SIGKILL last. A killed `e` leaks its worktree, which Leaks shows.
- Each harness has a full round trip in `scripts/e2e/scenarios/<h>-tui.json`
  (model) plus `<h>-tui.keys.json` (keys), for `h` in pi, codex, claude,
  opencode:

  | Harness     | Before the prompt                                                                                          | Quit         |
  | ----------- | ---------------------------------------------------------------------------------------------------------- | ------------ |
  | pi          | nothing; wait `stable` (startup downloads)                                                                 | `ctrl-d`     |
  | Codex       | "Open restricted" (`/workspace` is untrusted; `e resume`: "Open existing task"); commands ask for approval | one `ctrl-c` |
  | Claude Code | theme, security notes, folder trust, bypass-permissions warning: defaults all exit, so `down` + `enter`    | `/exit`      |
  | opencode    | nothing                                                                                                    | one `ctrl-c` |

- Quit with exactly what the harness needs: a Ctrl-C more than that reaches
  `e` itself, which then cancels the run.

## Gotchas

- The sandbox has no local stack, so egress-namespace and OmniRoute key
  features are out of reach; testing those means the user's own Store.
- `run` exits with `e`'s exit code; `--timeout <s>` (default 1200) sends
  SIGINT, then SIGKILL 15 s later - a short `--timeout` is how to test a
  Ctrl-C cancel of a one-shot run.
- `scripts/e2e/scenarios/*.json` are ready scripts; each names the command it
  goes with in `about`.
- pi downloads `fd` and `ripgrep` in every fresh container, so a pi step needs
  network access even with the stub model.
