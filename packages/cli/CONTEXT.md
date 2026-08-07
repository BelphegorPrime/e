# CLI

The `e` command: builds and runs coding-agent harnesses inside containers, one isolated run at a time. This context owns the vocabulary of harnesses, runtimes, and runs.

## Language

**Harness**:
A coding-agent CLI (e.g. Claude Code, Codex, opencode, Pi) packaged to run inside a container built from its own Dockerfile.
_Avoid_: agent, tool, model

**Run**:
One execution of a harness against a prompt, isolated in its own git worktree and branch and identified by a prompt-derived slug.
_Avoid_: job, task, session

**Runtime**:
The container engine — docker or podman — that builds and runs harness images.
_Avoid_: engine, backend, driver

**Spawn**:
To start a run.
_Avoid_: launch, create, exec
