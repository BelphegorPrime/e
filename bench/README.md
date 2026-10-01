# Fusion evaluation

Does a fusion (ADR-0019) produce better code than one Agent, by enough to pay
for N + 1 runs? This directory holds a small benchmark and the runner that
answers that for your own Agents. Single-agent execution is the baseline;
nothing here assumes fusion wins (#179).

```bash
# The harness itself, against a scripted model: no provider, no cost.
node scripts/eval/eval.mjs run bench/suites/smoke.json --model stub

# Your Agents, as your Store declares them.
node scripts/eval/eval.mjs run my-suite.json --model live --trials 5

# Re-aggregate a finished run.
node scripts/eval/eval.mjs report .eval/smoke-20261001T120000
```

The runner builds the CLI if `src/` is newer than `dist/`, then runs every
task under every arm, `trials` times, one trial after another. A run's output
lands in `.eval/<suite>-<timestamp>/` (git-ignored). It needs a container
engine (`$E_RUNTIME`, default `docker`), like `e` itself.

## What a trial is

1. **A fresh repository**: the task's `repo/` committed as `main`, with a
   local bare `origin`.
2. **One `e` invocation**: `e spawn <agent>` for a single arm, `e fuse <profile>`
   for a fusion arm, with the task's prompt, against a sandbox Store.
3. **The hidden check**: the task's `check/` files are copied into a detached
   checkout of each result branch, under `.eval-check/`, and the task's
   check command runs there in a container (no network unless the task asks).
   The Agent never sees these files, so weakening the repository's own tests
   cannot game the score. A fusion trial checks the synthesis branch and every
   candidate branch with commits.
4. **One record**, appended to `results.jsonl`.

The sandbox Store (`<out>/sandbox/.e`) is rendered by `e init` of the CLI under
test. It holds only the Agents and profiles the arms reach, copied from the
suite's Store and renamed `eval-<name>`, so no image of your own is rebuilt.
Before the first trial every Agent's image is built once by a warm-up run
against the stub, which costs no model call, so no trial's latency includes
a build (`--no-warmup` skips it). In `--model live` the Agents keep their
providers, and the keys they name (`apiKeyEnv`) are copied from the suite
Store's `.env` into the sandbox's, and nothing else of it; they are removed
again when the run ends or is interrupted. Skills an Agent bakes are copied
from the suite Store's `skills/`. Not supported in the sandbox: Agents on a
local runtime (the sandbox has no local stack) and `--mcp` servers.

## Adding a task

```text
bench/tasks/<name>/
  task.json   the prompt, the hidden check, optionally the in-run gate and stub turns
  repo/       the fixture: committed as the repository the Agent works in
  check/      the hidden check files, copied to .eval-check/ only for the check
```

```jsonc
// bench/tasks/<name>/task.json
{
  "prompt": "sum.js has a bug: ... Fix it.", // required, what every arm gets
  "check": {
    "command": "node --test '.eval-check/*.test.mjs'", // required, run in /workspace; exit 0 passes
    "image": "node:lts-alpine", // optional, default node:lts-alpine
    "timeoutMs": 600000, // optional, a timeout is a fail
    "network": false, // optional, default false
  },
  "verify": "node --test 'test/*.test.mjs'", // optional, the in-run gate (config.json's verify)
  "stub": { "turns": [/* see below */] }, // needed for --model stub only
}
```

- **The check decides, not the gate.** `verify` is the repository's own
  check that the run iterates against (ADR-0016); its verdict is recorded as
  a column of its own. Keep the hidden check stricter than or different from
  the repository's tests, or the two columns say the same thing.
- **Exit codes**: 0 passes; 125-127 is `broken` (the image could not run the
  command); anything else, and a timeout, fails.
- **Stub turns** are the solution, in the stub harness's tool calls (the
  table in `docs/agents/e2e.md`; the shipped store uses pi, so
  `{"tool":"bash","args":{"command":"..."}}`). The runner serves them once to
  every conversation that opens with the task: each candidate, the synthesis
  and each verify retry. A task without them runs with `--model live` only.

## Comparing strategies

A suite names the Store, the tasks and the arms:

```jsonc
// bench/suites/<name>.json
{
  "store": "../store", // a .e directory with agents/ and fusions/, relative to this file
  "tasks": ["fix-sum", "greet"], // directory names under ../tasks
  "trials": 3, // optional, default 1
  "timeoutMs": 7200000, // optional, one trial's wall clock, default 2 h
  "arms": [
    { "name": "single-claude", "agent": "claude" }, // the baseline
    { "name": "same-provider", "profile": "claude-x3" }, // candidates ["claude","claude","claude"]
    { "name": "cross-provider", "profile": "mix" }, // candidates ["claude","codex","pi"]
  ],
}
```

- **Single vs fusion**: one arm per Agent you would otherwise use alone,
  beside the profiles. A fusion has to beat the best single arm, not the
  average one.
- **Same-provider sampling**: a profile that repeats one Agent
  (`"candidates": ["claude", "claude", "claude"]`) separates "more samples"
  from "different models".
- **Cross-provider diversity**: a profile over different Agents.
- **Select vs synthesize**: there is no select strategy yet (ADR-0019
  section 11), so every fusion trial also reports, from the same candidates
  and at no extra run, `select@verify` (the candidate a select-only judge
  would pick: of each slot's last attempt, in profile order, the first whose
  in-run gate went green; with no gate declared, the first with commits) and
  `oracle` (whether any candidate passed the check: the ceiling a perfect
  selector could reach). Synthesis beating `select@verify` is the case for
  synthesizing at all.

Point a suite's `store` at your own Store (`~/.e`, or a checkout's `.e`) to
compare your real Agents. Use a dedicated profile per arm: the runner copies
only what the arms name.

## The output

```text
.eval/<suite>-<timestamp>/
  run.json        suite, model, e version and commit, arms, tasks, warm-up
  results.jsonl   one record per trial (schemaVersion 1)
  summary.json    the aggregate, per arm and per task and arm
  summary.md      the same as tables
  sandbox/        the sandbox Store; its runs/ keeps every ledger entry and fusion record
  trials/<task>/<arm>/<n>/
    trial.json    the trial's record
    e.log         e's output
    model.jsonl   every model request and reply (stub runs)
    checks/       each check's output
    repo/         the repository, every result branch in it
```

A record carries, per trial: the arm, its kind and strategy, the candidate
count, for a fusion the synthesizer and the whole profile as run, every
Agent's harness, version, provider protocol and model, the `e` version and
commit, a digest of the task's files, the in-run verify command, the trial
timeout, the latency, `e`'s exit code, the final branch with its
outcome, reason, in-run verify verdict and check verdict, every candidate's
outcome, slot, attempt, verify, elapsed time and check, `select`, and
`usage`. The aggregate per arm: check pass rate, verify green rate (over the
trials that had a gate), exit-0 rate, latency mean, p50 and max, mean
candidate count, candidate failure rate (per slot, its last attempt
`failed`, `timed-out` or `canceled`; `empty` is an answer),
`select@verify` and oracle pass rates, and usage.

**Usage is reported, never estimated.** No harness reports tokens or cost
to `e` (ADR-0019 section 5), so a live trial's `usage` is `null` and the
aggregate says `unavailable`. A stub trial sums the usage the stub's replies
carried, which tests the plumbing and nothing else.
