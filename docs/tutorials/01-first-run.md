# Tutorial 1: your first run

Goal: install `e`, initialize a Store, and get one coding agent to change a
repository for you. At the end you have a run branch you can diff, and you
know the difference between a one-shot run and the interactive TUI.

Time: 15 minutes plus the first image build.

## Before you start

- `git`, a container engine (`docker`, `podman`, `nerdctl`, or `finch`), and
  the `e` binary on `PATH`. The [Install](../../README.md#install) section of
  the README covers each platform.
- A git repository to work in. Any repository with at least one commit works;
  `e` never touches your checkout, it cuts a worktree per run.
- One model endpoint you can reach. This tutorial uses a hosted Anthropic key
  so nothing has to be downloaded. [Tutorial 3](./03-local-models.md) shows
  the local alternative.

Check the binary:

```bash
e --version
```

## Step 1: initialize the Store

The **Store** is the directory `e` reads its configuration from: harness
Dockerfiles, Agents, Skills, MCP servers, the local stack, and `.env`. It lives
under `<root>/.e`. Run the wizard from your home directory to get one Store
for the whole machine:

```bash
cd ~
e init
```

The wizard opens one settings menu for the choices (Space toggles a checkbox
or cycles a choice, Enter finishes, q quits), then asks the free-text values
on plain prompts. What to pick for this tutorial:

| Setting                | What to answer for this tutorial                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| Favorite harness       | `pi`. The favorite is what a bare `e spawn` runs                                                 |
| Local AI runtimes      | Select none. Local inference is [Tutorial 3](./03-local-models.md)                               |
| Git platform           | `github` (or `gitlab`, `forgejo`, `gitea`) if you want a PR/MR per run; none to skip PR creation |
| Preferred shell        | Your shell; `e init` writes the completion loader into its rc file                               |
| Installation directory | Accept the default (the directory you are in), so the Store becomes `~/.e`                       |
| API keys               | Paste your `ANTHROPIC_API_KEY`; leave the others blank                                           |
| OmniRoute password     | Enter, a random one is generated. Only the local gateway uses it                                 |

In a terminal without the menu (a pipe, a plain TTY) the same questions come
one by one.

`e init --yes` answers every question with its default and asks nothing, which
is what you want in CI or a script.

What you now have:

```text
~/.e/
  harnesses/<pi|claudeCode|codex|opencode>/Dockerfile   one image per Harness
  agents/<same names>/agent.json                          one default Agent per Harness
  skills/{web-search,conventional-commits,spawn-brother}/ shipped Skills
  mcp/{everything,filesystem,searxng}/                    shipped MCP servers
  compose.yaml, bootstrap.sh, egress/, broker/            the local stack and sidecars
  .env                                                    secrets, by name
  config.json                                             favorite harness, git platform, ...
```

The default Agents point at the local OmniRoute gateway, which is not running
yet. The next step gives you an Agent that talks to Anthropic directly.

## Step 2: define an Agent with a hosted Provider

An **Agent** is a named pairing of a Harness with a **Provider** (endpoint,
model, wire protocol, and the name of the env var holding the key). Create
one:

```bash
mkdir -p ~/.e/agents/pi-anthropic
cat > ~/.e/agents/pi-anthropic/agent.json <<'JSON'
{
  "name": "pi-anthropic",
  "harness": "pi",
  "provider": {
    "baseUrl": "https://api.anthropic.com",
    "model": "claude-sonnet-4-5",
    "protocol": "anthropic-messages",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  }
}
JSON
```

The directory name is the Agent's identity and must equal `name`. The key
value is never in this file; `apiKeyEnv` names the variable in `~/.e/.env`
that the wizard filled in. Check it is there:

```bash
grep ANTHROPIC_API_KEY ~/.e/.env
```

[Tutorial 2](./02-hosted-provider.md) explains which protocols each Harness
speaks and how each one receives the Provider.

## Step 3: run a one-shot task

Go into the repository you want changed and spawn. The `-d` flag makes the run
one-shot: the prompt is handed to the harness, the container exits when the
agent is done.

```bash
cd /path/to/your/repo
e spawn -d pi-anthropic "Add a CONTRIBUTING.md that explains how to run the tests"
```

Without `-d`, `e spawn <agent>` opens the harness's interactive TUI in the
container and the prompt is not passed along; use that mode to chat with the
agent inside its worktree.

What happens, in order:

1. The pi base image is built (once; slow, it installs the pi CLI and the
   skill collections). Then a thin derived image `e-agent-pi-anthropic` bakes
   the rendered `models.json`.
2. A worktree is cut on branch `e/pi-anthropic/<slug>-1`, from your current
   HEAD, and mounted at `/workspace` in the container.
3. pi runs with your prompt. Its shell, editor, and skills work inside
   `/workspace`; it has no git credentials and no engine socket.
4. When the container exits, the host commits whatever pi left uncommitted as
   `e: run output for <branch>`. On exit code 0 with new commits the branch is
   pushed to `origin` and, with a git platform configured, a PR/MR is opened
   into the branch you spawned from.

## Step 4: look at the result

Your checkout is untouched. The work is on the run branch:

```bash
git branch --list 'e/*'
git log --oneline HEAD..e/pi-anthropic/<slug>-1
git diff HEAD...e/pi-anthropic/<slug>-1
```

Merge it, cherry-pick from it, or delete it. If a PR/MR was opened its URL
was printed at the end of the run.

To poke around the exact filesystem the agent saw, keep the worktree:

```bash
e spawn -d --keep-worktree pi-anthropic "Try upgrading to express 5 and note what breaks"
```

The worktree path is under the platform's worktrees directory (see
[Platform notes](../../README.md#platform-notes)); remove it later with
`git worktree remove <path>`.

## Step 5: talk to the agent instead

Same Agent, no prompt, no `-d`:

```bash
e spawn pi-anthropic
```

The pi TUI opens inside the container. Everything you do together lands in
the same kind of run branch when you quit. Give the run a readable name when
the branch matters:

```bash
e spawn --name docs-cleanup pi-anthropic
```

## Where to go next

- Other harnesses or another gateway: [Tutorial 2](./02-hosted-provider.md).
- No hosted key, run models on your own hardware: [Tutorial 3](./03-local-models.md).
- Give agents Skills and MCP servers: [Tutorial 4](./04-skills.md), [Tutorial 5](./05-mcp-servers.md).
- Something went wrong: `e -v spawn ...` prints debug logs; the
  [README](../../README.md#test) has the rendering checks that show exactly
  what a Harness receives.
