# Tutorial 4: give an agent a Skill

Goal: write a Skill, add it to one run, bake it into an Agent, and see where
it ends up inside the container.

Prerequisite: one working Agent ([Tutorial 1](./01-first-run.md)).

## What a Skill is

A **Skill** is a directory with a `SKILL.md` (front matter with `name` and
`description`, then instructions) plus any resource files, following the
[Agent Skills](https://github.com/agentskills/agentskills) layout. Harness
CLIs load Skills from a directory outside `/workspace`, so a Skill never lands
in a run's branch:

| Harness      | Reads Skills from           |
| ------------ | --------------------------- |
| `pi`         | `~/.agents/skills` (shared) |
| `codex`      | `~/.agents/skills` (shared) |
| `opencode`   | `~/.agents/skills` (shared) |
| `claudeCode` | `~/.claude/skills`          |

Skills reach a run through three layers:

| Layer | How                                    | Scope                             |
| ----- | -------------------------------------- | --------------------------------- |
| 1     | Skill collections in the Harness image | every run of that Harness         |
| 2     | `"skills": [...]` in `agent.json`      | every run of that Agent (baked)   |
| 3     | `e spawn --skill <name>`               | this run only (mounted read-only) |

`e init` ships three Skills into `~/.e/skills/`: `web-search` (baked into the
default Agents), `conventional-commits`, and `spawn-brother`
([Tutorial 6](./06-sibling-runs.md)).

## Step 1: write one

A Skill that makes the agent leave a short change log in every run:

```bash
mkdir -p ~/.e/skills/changelog-note
cat > ~/.e/skills/changelog-note/SKILL.md <<'MD'
---
name: changelog-note
description: Record what changed and why in CHANGELOG-NOTES.md at the repository root. Use at the end of every task that edits files.
---

# Changelog note

Before you finish a task that changed files:

1. Open `CHANGELOG-NOTES.md` at the repository root; create it if missing.
2. Prepend one entry: today's date, one line per changed area, one line on
   why. Keep the whole entry under 10 lines.
3. Do not touch any other file for this step.
MD
```

The directory name is the Skill's name; `e` checks the `SKILL.md` exists
before it builds anything, and lists the available names when it does not:

```bash
e spawn --skill does-not-exist pi-anthropic "hi"
# Unknown skill "does-not-exist". Available: changelog-note, conventional-commits, spawn-brother, web-search. ...
```

## Step 2: add it to one run

```bash
cd /path/to/repo
e spawn --skill changelog-note pi-anthropic "Rename the helper in src/util.ts from fmt to formatDate and update its callers"
```

Several at once, either way:

```bash
e spawn --skill changelog-note,conventional-commits pi-anthropic "..."
e spawn --skill changelog-note --skill conventional-commits pi-anthropic "..."
```

Check the branch: `CHANGELOG-NOTES.md` should be in the run's commits, the
Skill itself should not.

## Step 3: bake it into an Agent

Add it to the Agent so every run carries it:

```bash
cat > ~/.e/agents/pi-anthropic/agent.json <<'JSON'
{
  "name": "pi-anthropic",
  "harness": "pi",
  "provider": {
    "baseUrl": "https://api.anthropic.com",
    "model": "claude-sonnet-4-5",
    "protocol": "anthropic-messages",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  },
  "skills": ["web-search", "changelog-note"]
}
JSON
e spawn --rebuild pi-anthropic "List the skills you have available, then exit"
```

Baked Skills are copied into the derived image, so a changed Skill or a
changed list needs `--rebuild`. A per-run `--skill` is a mount and needs
none.

## Step 4: see it from inside

Open the TUI and ask the harness itself:

```bash
e spawn pi-anthropic
# in pi: ls ~/.agents/skills
```

A Harness without Skill support rejects `--skill` and baked `skills` up
front, before any image is built.

## Ship a Skill with a script

A Skill may carry files next to `SKILL.md`; the shipped `spawn-brother` Skill
is one (`spawn-brother.mjs`). Reference them by the Skill directory the
Harness loads from, for example
`~/.agents/skills/<name>/<file>`, never by a `/workspace` path.
