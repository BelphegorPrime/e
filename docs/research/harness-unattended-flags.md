# Harness unattended flags and exit-code semantics

Research for issue #143 (child of map #139, "Autonomous runs in e"). Question:
**what does each of `e`'s four harnesses need in order to run truly unattended -
no approval prompts, no TTY - and what are its exit-code semantics?**

Gathered 2026-09-17. Every claim below cites its primary source: an official doc
URL, a source file in the harness's own repository/package, or the exact command
whose output was observed. Claims that could not be confirmed from a primary
source are marked _unverified_.

This file supersedes the "Headless" bullets of
[`harness-cli-facts.md`](harness-cli-facts.md) (gathered 2026-08-08) where the
two disagree; it does not restate that file's provider/MCP/skills findings.

> **Status:** the two argv changes this research called for landed in
> [#152](https://github.com/BelphegorPrime/e/issues/152) - Codex now carries
> `--dangerously-bypass-approvals-and-sandbox` and opencode `--auto`. The
> section "What `e` does today" below is therefore a record of the state this
> research measured, not of the current registry; everything else still holds.

## Answers at a glance

|                                    | **pi**                                                | **Claude Code**                                                            | **Codex**                                                                 | **opencode**                                              |
| ---------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- |
| Version checked                    | 0.85.1                                                | 2.1.267 (docs to 2.1.274)                                                  | 0.147.0                                                                   | 1.18.31                                                   |
| Unattended flag needed             | **none**                                              | `--dangerously-skip-permissions` (= `--permission-mode bypassPermissions`) | **`--dangerously-bypass-approvals-and-sandbox`**                          | **`--auto`**                                              |
| What `e` passes today              | `pi -p <prompt>` - **correct**                        | `claude -p <prompt> --dangerously-skip-permissions` - **correct**          | `codex exec <prompt>` - **broken: read-only sandbox**                     | `opencode run <prompt>` - **silently auto-denies**        |
| Blocks on a human?                 | never                                                 | never (`-p` denies what it cannot ask)                                     | never (raises → fails, exit 1)                                            | never (auto-**rejects**)                                  |
| **Refusal exits**                  | **0**                                                 | **0** (_inferred_)                                                         | **0** (confirmed in source)                                               | **0**                                                     |
| **Blocked tool / guardrail exits** | **0**                                                 | **0** (run continues)                                                      | **0** (denial fed back to model)                                          | **0** (loop halts, stdout empty)                          |
| Unusable/empty prompt exits        | 1                                                     | 1                                                                          | 1                                                                         | 1                                                         |
| API / auth error exits             | 1 (text mode only)                                    | 1                                                                          | 1                                                                         | 1                                                         |
| Other codes                        | 143/129 on SIGTERM/SIGHUP                             | 143 on SIGTERM                                                             | 2 on CLI parse error                                                      | -                                                         |
| Structured output                  | `--mode json` (JSONL) - **but then exit is always 0** | `--output-format json`, `--json-schema` → `structured_output`              | `--json` (JSONL) + `--output-schema` + `-o <file>`                        | `--format json` (NDJSON), **no result envelope**          |
| Best machine verdict               | final `stopReason` in the stream                      | `is_error` + `stop_reason` + `permission_denials`                          | **`-o <file>` written ⇔ turn completed**, plus a forced `--output-schema` | scan NDJSON for `tool_use` with `state.status == "error"` |
| TTY required                       | no                                                    | no                                                                         | no                                                                        | no                                                        |
| Session resume                     | `-c`, `-r`, `--session`, `--fork`                     | `-c`, `-r`, `--session-id`, `--fork-session`                               | `codex exec resume [--last]` (no headless fork)                           | `-c`, `-s`, `--fork`                                      |

**The one-line answer to the ticket's decisive question: on all four harnesses a
refusal, a hit guardrail and a blocked tool call exit 0.** The exit code is a
liveness signal ("the process reached the end without crashing"), never a verdict
on the work. `e`'s current `if (exitCode === 0)` therefore already mis-reads
refusals as success on every harness - it is only saved today by the fact that a
refusing agent leaves the worktree clean, so `git.isDirty()` is false and nothing
gets committed. That accident stops being protective the moment a run is allowed
to iterate.

---

## What `e` does today (the thing being measured against)

- The container argv per harness is built by the `HARNESSES` registry in
  [`src/core/harness/index.ts`](../../src/core/harness/index.ts), which at the
  time of writing produced:
  - pi: `pi -p <prompt>` (+ `--provider e --model <id>` when an agent declares a provider)
  - Claude Code: `claude -p <prompt> --dangerously-skip-permissions`
  - Codex: `codex exec [-m <model>] <prompt>`
  - opencode: `opencode run <prompt>`
- The harness runs as the non-root `node` user by default
  (`src/core/harness/renderDockerfile.ts`, `NODE_HOME = '/home/node'`).
- A one-shot run is spawned **without** `-i`/`-t`: `ports/runtime/index.ts` only
  pushes `-it` when `opts.interactive` is set, which `runSpawn` sets only for
  `e spawn` with no prompt. **Every unattended run therefore has no TTY on any
  of stdin/stdout/stderr.**
- The container's **exit code is the only completion signal**
  ([`src/engine/runs/runSpawn.ts:499-531`](../../src/engine/runs/runSpawn.ts)):
  `if (exitCode === 0)` the worktree is committed, the branch pushed and a PR
  opened; non-zero means nothing is committed, nothing is pushed. There is no
  stdout parsing, no report file, no judge.
- The harness image installs the CLI **unpinned** (`npm install -g <package>` in
  `renderDockerfile.ts`), so the version in the image is whatever npm served at
  build time. Any flag spelling recorded here is a claim about _today's_ latest,
  not about a pinned version.

---

## pi (`@earendil-works/pi-coding-agent`, `pi`)

Sources: `pi --help` (v0.84.1, `/home/marcel/.local/bin/pi`, observed
2026-09-17); the published npm tarball **v0.85.1** (latest; obtained with
`npm pack @earendil-works/pi-coding-agent@0.85.1`), which bundles both `docs/`
and unminified `dist/`. File references below are paths inside that tarball.

**1. Unattended flags - nothing is needed, and the old record is still correct.**

`pi -p "<prompt>"` is the complete headless invocation. pi has no approval
prompts and no sandbox to bypass:

> "Pi does not include a built-in sandbox. Built-in tools can read files, write
> files, edit files, and run shell commands with the permissions of the pi
> process." - `docs/security.md`, _No Built-in Sandbox_

The only gate is **project trust**, and it is already resolved without a human
in headless mode:

> "Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a
> trust prompt. Without an applicable saved trust decision,
> `defaultProjectTrust: "ask"` and `"never"` ignore such resources, while
> `"always"` trusts them. Use `--approve`/`-a` or `--no-approve`/`-na` to
> override project trust for one run." - `docs/security.md`, _Project Trust_
> (identical wording in `docs/settings.md:16`)

Consequence for `e`: **`pi -p` never blocks**, but under the default
`defaultProjectTrust: "ask"` a run **silently ignores** `/workspace/.pi/*`,
project `.agents/skills` and project-local extensions. If `e` ever wants the
run's own repo to contribute skills/extensions it must pass `--approve`/`-a`.
That is a capability question, not a liveness one.

pi also documents the containerised, unattended pattern as the recommended one:

> "For untrusted repositories, generated code you do not intend to monitor
> closely, or unattended automation, run pi in a contained environment."
>
> - `docs/security.md`, _Running Untrusted or Unmonitored Work_

**2. Exit codes - a refusal exits 0, and `--mode json` exits 0 for everything.**

The whole exit-code logic of headless pi is `dist/modes/print-mode.js`
(`runPrintMode`), whose return value becomes `process.exitCode` in
`dist/main.js:790-799`:

```js
let exitCode = 0;
...
    if (mode === "text") {
        const state = session.state;
        const lastMessage = state.messages[state.messages.length - 1];
        if (lastMessage?.role === "assistant") {
            const assistantMsg = lastMessage;
            if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
                console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
                exitCode = 1;
            }
            ...
        }
    }
    return exitCode;
}
catch (error) { console.error(...); return 1; }
```

The full set of stop reasons is
`"stop" | "length" | "toolUse" | "error" | "aborted"`
(`docs/session-format.md:88`). So, for `pi -p` (text mode):

| Situation                                        | stopReason | exit                           |
| ------------------------------------------------ | ---------- | ------------------------------ |
| Task done                                        | `stop`     | **0**                          |
| **Model refuses / says it cannot**               | `stop`     | **0**                          |
| **Context window exhausted mid-task**            | `length`   | **0**                          |
| **Last message is a tool call, work unfinished** | `toolUse`  | **0**                          |
| Provider/API/auth error on the final turn        | `error`    | 1                              |
| Aborted                                          | `aborted`  | 1                              |
| Thrown exception (bad flag, unknown provider, …) | -          | 1                              |
| `SIGTERM` / `SIGHUP`                             | -          | 143 / 129 (`print-mode.js:40`) |

Two sharp edges:

- Only the **last** message is inspected. A run whose final turn succeeds after
  an earlier API error still exits 0.
- **`--mode json` cannot fail.** The exit-code block is inside
  `if (mode === "text")`, so `pi --mode json` returns 0 for _every_ outcome
  except a thrown exception. Adopting pi's structured output would mean giving
  up the little exit-code signal pi has.

Observed locally (v0.84.1, stdin `/dev/null`, stdout piped - no TTY anywhere):

```
$ pi -p --provider __nope__ --model __nope__ "hi" < /dev/null
Error: Unknown provider "__nope__". Use --list-models to see available providers/models.
exit=1
$ pi --definitely-not-a-flag < /dev/null            # exit=1
$ pi --list-models < /dev/null                      # exit=0, table on stdout
```

**3. Structured output.** `--mode json` emits a JSONL event stream: a session
header line, then `agent_start` / `turn_start` / `message_start` /
`message_update` / `message_end` / `turn_end` / `agent_end` events, plus
`tool_execution_end` carrying `isError` (`docs/json.md`). `--mode rpc` is the
bidirectional process-integration mode (`docs/rpc.md`). There is no
"write a report file" flag; `--export <file>` only renders an existing session
to HTML (`pi --help`). A verdict is derivable from the stream - the final
assistant message's `stopReason` - but only by parsing it host-side.

**4. TTY.** Not required. Print mode never touches the TUI, and the probes above
ran with stdin at `/dev/null` and stdout piped. `docs/containerization.md`
documents `docker run` with `ENTRYPOINT ["pi"]` as a supported pattern.

**5. Session continuation.** Rich: `--continue`/`-c`, `--resume`/`-r`,
`--session <path|id>`, `--session-id <id>`, `--fork <path|id>`,
`--session-dir <dir>`, `--no-session` (`pi --help`). Recorded for completeness;
`e`'s loop uses a fresh container per iteration and will not use these. Note
`--no-session` is the flag that makes a run leave nothing behind.

---

## Claude Code (`@anthropic-ai/claude-code`, `claude`)

Sources: official docs at `https://code.claude.com/docs/en/<page>.md` (pages
`permission-modes`, `cli-reference`, `headless`, `permissions`, `errors`,
`env-vars`, `changelog`, `agent-sdk/{agent-loop,typescript,python,structured-outputs}`,
`sandbox-environments`, `devcontainer`), fetched 2026-09-17; `claude --help` on
the locally installed **v2.1.267**; and exit codes observed locally with cheap
no-token invocations (each labelled below). Docs describe up to v2.1.274.

**1. Unattended flags - `e`'s current argv is exactly the documented recipe.**

`permission-modes.md`, §"Common setups", has a table row reading:

> | Run fully unattended inside a container | `claude -p "<prompt>" --dangerously-skip-permissions` | Required: a container, VM, or the sandbox runtime; on Linux and macOS, run it as a non-root user | … In this `-p` run, the few calls that would still prompt are denied instead |

So `['claude', '-p', prompt, '--dangerously-skip-permissions']` in
`src/core/harness/index.ts:130-135` is **correct and current**. Details worth
recording:

- `--dangerously-skip-permissions` is documented as "Equivalent to
  `--permission-mode bypassPermissions`" (`cli-reference.md`). Not deprecated;
  no deprecation entry in `changelog.md`.
- `--allow-dangerously-skip-permissions` (which also appears in `--help`) is a
  _different_ flag: "Add `bypassPermissions` to the `Shift+Tab` mode cycle
  **without starting in it**" (`cli-reference.md`). It is useless in `-p`.
- **Root refusal**: "On Linux and macOS, Claude Code refuses to start in this
  mode when running as root or under `sudo`… The check is skipped automatically
  inside a recognized sandbox." (`permission-modes.md`, repeated in
  `sandbox-environments.md` and `devcontainer.md`.) `e` is safe here - its
  harness images run as the non-root `node` user. This is a constraint to keep,
  not a change to make.
- **Behaviour change in 2.1.257**: `defaultMode: "bypassPermissions"` in a
  _project's_ `.claude/settings.json` is now ignored. `e` passes the flag, so it
  is unaffected - but it means a repo cannot opt itself into bypass either.
- `-p`'s built-in default permission mode is `default` (Manual)
  (`permission-modes.md`, §"Which permission mode a session starts in"), so the
  flag is load-bearing: without it a `-p` run would deny rather than ask.
- `--permission-prompts none` (v2.1.259+) is the complementary flag: "Pass
  `none` when nobody can answer, and Claude Code denies them instead"
  (`cli-reference.md`). `headless.md` adds that it also _removes_ tools needing a
  human (`AskUserQuestion`) and tells the model not to retry. In a `-p` run with
  no SDK host those requests are denied either way, so this is a clarity/latency
  win rather than a liveness fix.
- `--permission-mode dontAsk` is the documented CI alternative: "auto-denies
  every tool call that would otherwise prompt you… the session never waits for
  input" (`permission-modes.md`). It is _more_ restrictive than bypass, not less.
- **Nothing auto-approves everything.** `permission-modes.md`, §"Actions no mode
  auto-approves": explicit `ask` rules, `AskUserQuestion`, MCP tools marked
  `requiresUserInteraction`, and `rm`/`rmdir` against critical paths still
  prompt - and therefore get denied - even under `bypassPermissions`.
- **`--bare` is worth considering for `e`.** `headless.md`: without it, "a `-p`
  session runs the hooks in a project's `.claude/settings.json` and connects the
  servers in its `.mcp.json`, even in a folder you've never trusted." Since `e`
  checks an arbitrary repo into `/workspace`, an untrusted repo can currently run
  hooks inside the run container. `--bare` also restricts auth to
  `ANTHROPIC_API_KEY`, which is what `e` supplies, and the docs say it "will
  become the default for `-p` in a future release".

**2. Exit codes - no documented table; a refusal exits 0; a denied tool exits 0.**

The only normative statement, `headless.md`:

> "Claude Code exits with code 0 on success and a non-zero code when the run
> fails, so your scripts can branch on the exit status. … When a failure happens
> inside the run, such as missing authentication, Claude Code prints the failure
> as the result on stdout."

Plus two specific codes: **143** for SIGTERM ("leaves the turn that was in
progress unfinished and records no result for it", `headless.md`) and **1** for
every startup/CLI error enumerated in `errors.md`.

| Situation                                                                       | Exit     | Source                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task completes                                                                  | 0        | `headless.md`                                                                                                                                                                                                                     |
| **Model refuses / declines**                                                    | **0**    | _inferred_: `agent-loop.md` puts `stop_reason: "refusal"` on the **success** arm, and `python.md` says `is_error` is true on `success` only "when the final model request failed". Not stated literally - see _unverified_ below. |
| **A permission/guardrail blocks a tool**                                        | **0**    | `permission-modes.md`: "the action doesn't run and Claude keeps working… **Claude Code doesn't stop the run in either case.**" Denials are listed in `permission_denials`.                                                        |
| Usage-Policy / cyber-safeguard refusal                                          | non-zero | `errors.md` - surfaces as an API error, so `is_error: true`                                                                                                                                                                       |
| Empty / whitespace-only prompt                                                  | 1        | `errors.md`; observed locally: `claude -p --output-format json ""` → exit 1                                                                                                                                                       |
| Semantically useless but non-empty prompt                                       | 0        | ordinary successful run                                                                                                                                                                                                           |
| API / auth / connection error                                                   | 1        | observed locally (below)                                                                                                                                                                                                          |
| `--max-turns` / `--max-budget-usd` exhausted                                    | non-zero | `cli-reference.md` "Exits with an error when the limit is reached"; `agent-loop.md` "The underlying Claude Code process also exits with a nonzero code". Exact number _unverified_.                                               |
| Invalid flag / invalid `--json-schema` / bad `--session-id` / failed `--resume` | 1        | `errors.md`; all observed locally                                                                                                                                                                                                 |
| SIGTERM                                                                         | 143      | `headless.md`                                                                                                                                                                                                                     |

Observed locally (no tokens spent), exact command:

```
env -i PATH=/usr/bin:/bin HOME=$HOME ANTHROPIC_BASE_URL=http://127.0.0.1:1 \
  ANTHROPIC_API_KEY=sk-ant-fake-000 CLAUDE_CODE_MAX_RETRIES=0 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  claude --bare -p "hi" --output-format json --no-session-persistence --tools ""
```

→ **exit 1**, and a JSON result with `subtype:"success"` **but**
`is_error:true`, `terminal_reason:"api_error"`,
`result:"API Error: Connection refused …"`. The same shape with no credentials
at all gives `result:"Not logged in · Please run /login"`, exit 1.

**The trap to record: `subtype` was `"success"` while `is_error` was `true`.**
Gate on `is_error`, never on `subtype`.

**3. Structured output - the best of the four.** `--output-format json` returns a
single result object; `--output-format stream-json` (needs `--verbose`) is
newline-delimited with the `result` message last (`headless.md`). Fields verified
against `agent-sdk/typescript.md` (`SDKResultMessage`): `type`, `subtype`,
`is_error`, `result`, `stop_reason`, `num_turns`, `total_cost_usd`, `usage`,
`modelUsage`, `permission_denials` (`{tool_name, tool_use_id, tool_input}`),
`structured_output?`, `terminal_reason?`, `session_id`, `duration_ms`. The error
arm uses `subtype: "error_max_turns" | "error_during_execution" |
"error_max_budget_usd" | "error_max_structured_output_retries"`, drops `result`
and adds `errors: string[]`. `--json-schema <schema>` puts a schema-validated
object in `structured_output`; `structured-outputs.md` warns a run "can also end
with subtype `success` but no `structured_output` value… Treat that case as a
failure as well." There is **no `--output-file`/`--report` flag** (checked
against `cli-reference.md` and the full local `--help`); redirection or the
`Write` tool are the routes to a file.

**4. TTY - not required, and the absence of one has side effects `e` inherits.**
`claude --help` on `-p`: "The workspace trust dialog is skipped when Claude is run
in non-interactive mode (via `-p`, or when stdout is not a TTY…). Only use this
in directories you trust. **Settings files that fail validation are silently
ignored in this mode** (no error dialog is shown)." `permissions.md`: "A `claude
-p` run or an SDK session never shows it." Every probe above ran with neither
stdin nor stdout a TTY. Two stdin caveats from `headless.md`: piped stdin is
capped at 10 MB (exceeding it exits non-zero), and an unreadable stdin produces a
warning on stderr and the run continues with the argv prompt. No documented
problem with `docker run` without `-t`.

**5. Session continuation.** `--continue`/`-c` (note: plain `--continue` _skips_
`-p`-created sessions; `claude -p --continue` includes them), `--resume`/`-r
<id|name|path>`, `--session-id <uuid>` (choose the ID up front), `--fork-session`,
`--no-session-persistence` (print mode only). Recorded for completeness only.

_Unverified for Claude Code_: there is no exit-code table in the docs; every
non-zero code observed was `1`, and whether any path returns something other than
0/1/143 is unknown. "A refusal exits 0" is a strong inference from the documented
`is_error`/success semantics, not a literal quotation. The root/sudo refusal's
exit code was not reproduced. `--max-turns` is accepted by 2.1.267 but absent
from its `--help`, so `--help` is an incomplete flag list.

---

## opencode (`opencode-ai`, `opencode`)

Sources: the `sst/opencode` repository at tag **`v1.18.31`** (the current npm
`latest`), read from a shallow clone; its docs `.mdx` under
`packages/web/src/content/docs/` (which back `https://opencode.ai/docs/...`);
and a real local install of `opencode-ai@1.18.31` whose `--help` and exit codes
were observed directly. Drift check: `git diff v1.18.31 HEAD` is empty for
`packages/opencode/src/cli/cmd/run.ts` and `permissions.mdx`, so the line numbers
below hold for both the tag and `dev` HEAD.

**1. Unattended flags - `--auto` is still the right spelling, and it is a real
CLI flag.**

`packages/opencode/src/cli/cmd/run.ts:241-246`:

```ts
.option("auto", {
  type: "boolean",
  describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
  default: false,
})
```

Documented in `packages/web/src/content/docs/permissions.mdx` §"Auto mode"
(`https://opencode.ai/docs/permissions/`): "Start OpenCode with `--auto` to
automatically approve permission requests that are not explicitly denied… You
can also use auto mode with `opencode run`… Explicit `"deny"` rules are still
enforced." Also listed in `cli.mdx:384`.

`--yolo` and `--dangerously-skip-permissions` exist as `hidden: true` aliases
OR-ed with `--auto` at `run.ts:274`; they are undocumented, so `--auto` is the
spelling to use. Config-only equivalents: `"permission": "allow"` in
`opencode.json`, or the `OPENCODE_PERMISSION` env var (inline JSON, merged in
`packages/opencode/src/config/config.ts:559-565` - note malformed JSON there is
**silently skipped with a log warning**, falling back to the default).

**The 2026-08-08 record's claim that "`opencode run <prompt>` will prompt on
permissions" is wrong.** Three layers decide:

1. Base defaults are permissive (`packages/opencode/src/agent/agent.ts:119-135`):
   `"*": "allow"`, so `bash`/`edit`/`webfetch` are allowed; `doom_loop: "ask"`,
   `external_directory: "ask"`, `read` of `*.env`: `"ask"`.
2. `run` injects a session ruleset denying the interactive escapes
   (`question`, `plan_enter`, `plan_exit`) when not in interactive mode
   (`run.ts:430-447`) - this is what stops the agent hanging on a question tool.
3. Anything still resolving to `ask` is **auto-rejected, not prompted**
   (`run.ts:801-820`): without `--auto` it replies `"reject"` and prints
   `permission requested: … ; auto-rejecting` to stderr.

So `opencode run` **never blocks on a human** even today. `--auto` is still
needed, because `external_directory: "ask"` fires on any path outside cwd and
would otherwise be silently rejected. None of this auto-reject behaviour is
documented in the `.mdx` docs - it is source-only.

**2. Exit codes - a denied permission exits 0 with empty stdout.**

No exit-code table exists (`grep -rn -i "exit code\|exit status\|exits with"
packages/web/src/content/docs/*.mdx` → zero hits). The logic is in `run.ts`:
`process.exit(1)` for argument/setup failures, and `process.exitCode = 1` set
only when the event loop throws, the `session.prompt` HTTP call returns an
error, or a `session.error` event arrives (`run.ts:781-790, 837-873`); plus the
top-level catch in `packages/opencode/src/index.ts:126-136`.

| Situation                                                                   | Exit  | Evidence                                                                                                                     |
| --------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| Task completes                                                              | 0     | observed                                                                                                                     |
| **Model refuses in prose**                                                  | **0** | no `session.error`; indistinguishable from success (_inferred from source_)                                                  |
| Provider **content-filter** refusal (e.g. Anthropic `stop_reason: refusal`) | 1     | `packages/opencode/src/session/prompt.ts:1301-1308` publishes a `ContentFilterError`                                         |
| **Permission denied / auto-rejected**                                       | **0** | `processor.ts:200-201` sets `ctx.blocked`; `processor.ts:694` halts the loop and publishes **no** `session.error`. Observed. |
| Empty message and no `--command`                                            | 1     | `run.ts:421-423`                                                                                                             |
| Unknown flag                                                                | 1     | observed                                                                                                                     |
| Bad `--session <id>`                                                        | 1     | `run.ts:464-467`, observed                                                                                                   |
| **Unknown `--agent`**                                                       | **0** | warns and silently falls back to the default agent. Observed.                                                                |
| API / auth / model error                                                    | 1     | observed with a bogus model                                                                                                  |

Observed locally (`opencode-ai@1.18.31`, stdin `</dev/null`, no TTY), in a
directory whose `opencode.json` set `{"permission": {"bash": "ask"}}`:

```
$ opencode run "Run the shell command: echo HELLO_FROM_BASH …" </dev/null
exit=0
stdout: (empty)
stderr: ! permission requested: bash (echo HELLO_FROM_BASH); auto-rejecting
        ✗ echo HELLO_FROM_BASH failed
        Error: The user rejected permission to use this specific tool call.
```

The same prompt with `--auto` → exit 0 and `HELLO_FROM_BASH` on stdout.
`opencode run --agent nosuchagent "say OK"` → exit 0 with a warning.

**For `e` this is the worst case of the four: exit 0 cannot distinguish "did the
work" from "refused" from "was blocked".** "Exit 0 with empty stdout" is the
denial fingerprint, but only a heuristic. (Note: an _explicit_ `"deny"` rule
raises `DeniedError`, not `RejectedError`, so it does **not** set `ctx.blocked`
and the loop continues with the error fed back to the model -
`permission/index.ts:75-78` vs `processor.ts:200`.)

**3. Structured output.** `--format json` (spelling verified,
`run.ts:174-179`, `choices: ["default", "json"]`) emits NDJSON on stdout, one
object per line: `{type, timestamp, sessionID, ...data}` (`run.ts:676-690`).
`type` ∈ `step_start`, `step_finish`, `tool_use`, `text`, `reasoning`, `error`.
**There is no final result envelope** - no `is_error`, no `subtype`, no summary
line. What is checkable:

- a line with `"type":"error"` carrying `{name, data:{message, ref}}`;
- a `tool_use` line whose `part.state.status === "error"` - this is where a
  permission rejection surfaces (`part.state.error === "The user rejected
permission to use this specific tool call."`), and the _only_ machine-readable
  trace of it, since the exit code is 0;
- normal completion: the last `step_finish` has `part.reason === "stop"`.

Stream separation (`packages/opencode/src/cli/ui.ts:31-38`): with
`--format json`, stdout is pure NDJSON and all warnings go to stderr. With the
default format and **no TTY** (the `e` case), stdout carries assistant text only.
No output-file flag; `opencode export [sessionID]` and `opencode session list
--format json` exist as after-the-fact routes (`cli.mdx:466-482`). `opencode
serve` + `opencode run --attach http://localhost:4096` is the documented pattern
for many runs in one container (`cli.mdx:355-364`, `server.mdx`).

**4. TTY - not required, but there is a stdin trap.** `run.ts` never references
the TUI (that is a separate `cmd/tui.ts`); the only TTY guard is for the hidden
interactive `--mini` mode (`run.ts:319`: `if (interactive && !process.stdout.isTTY)
die("--mini requires a TTY stdout")`). Observed runs with both stdin and stdout
non-TTY worked, including real model calls and tool execution.

The trap, `run.ts:416`:

```ts
const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text();
```

With a non-TTY stdin, opencode **reads stdin to EOF and appends it to the
prompt**. Observed: `(sleep 15; echo) | opencode run "hi"` idled 15 s before
starting. `e` is safe today because a one-shot run passes neither `-i` nor `-t`,
so the container's stdin is already closed - but this is a landmine if `e` ever
adds `-i`.

**5. Session continuation.** `-c/--continue` (most recent _root_ session for the
directory, `run.ts:489`), `-s/--session <id>`, `--fork` (requires one of the
previous two), `--share`. Recorded for completeness. One warning: `--share`
publishes the session publicly at `opncd.ai/s/<id>` (`share.mdx`) - it must never
be switched on by accident in an autonomous run.

_Unverified for opencode_: a prose refusal exiting 0 is read from source
(`prompt.ts` only errors on `finish === "content-filter"`), not induced from a
live model; and the `docker run` without `-t` claim is inferred from the non-TTY
local runs plus the absence of a TTY guard on the `run` path.

---

## OpenAI Codex CLI (`@openai/codex`, `codex`)

Sources: the `openai/codex` repository at tag **`rust-v0.147.0`** (the version
inside `e`'s already-built `e-harness-codex:latest` image), read via
`https://raw.githubusercontent.com/openai/codex/rust-v0.147.0/...`; the GitHub
release notes for that tag; the official non-interactive-mode doc at
`https://learn.chatgpt.com/docs/non-interactive-mode`; and runs observed with
`docker run --rm --entrypoint sh e-harness-codex:latest -c '<cmd>'`.

**1. Unattended flags - `e`'s current Codex argv is wrong in a way that fails
silently.**

`codex exec` with no flags does **not** ask for approvals - the approval policy
is hardcoded to `Never` in `codex-rs/exec/src/lib.rs:397-403`:

```rust
let overrides = ConfigOverrides {
    model,
    review_model: None,
    // Default to never ask for approvals in headless mode. Rebuild below if
    // the fully resolved reviewer is AutoReview.
    approval_policy: Some(AskForApproval::Never),
```

But **the default sandbox is `read-only`**: "By default, `codex exec` runs in a
read-only sandbox" (`https://learn.chatgpt.com/docs/non-interactive-mode`), and
observed in the header `codex exec` prints to stderr:

```
approval: never
sandbox:  read-only
```

So `['codex', 'exec', prompt]` (`src/core/harness/index.ts:175-178`) gives a
Codex that **cannot write to the worktree**. Its writes are denied, the denials
are fed back to the model as tool output, the turn still completes, and the
process **exits 0** - after which `e` finds a clean worktree, commits nothing,
pushes nothing, and calls the run a success. This is the single most consequential
finding in this document.

Corrections to `harness-cli-facts.md:81`:

- "`codex exec <prompt>` defaults to a read-only sandbox with approvals" - the
  read-only half is right, the approvals half is wrong.
- **`-a`/`--ask-for-approval` does not exist on `codex exec` in 0.147.0.** It is
  defined only in the TUI crate (`codex-rs/tui/src/cli.rs:65`); the struct shared
  by both entry points, `SharedCliOptions`
  (`codex-rs/utils/cli/src/shared_options.rs:10-73`), has no approval field.
  Observed: `codex exec --ask-for-approval never "x"` → `error: unexpected
argument '-a' found`, **exit 2**. The old record's suggested pairing would not
  parse.
- **`--full-auto` was removed in 0.147.0.** Release notes for `rust-v0.147.0`:
  "Remove the deprecated `codex exec --full-auto` flag; use `--sandbox
workspace-write` instead. (#36054)". It was deprecated in `rust-v0.128.0`.
- `--dangerously-bypass-approvals-and-sandbox` - spelling **confirmed** (it was
  marked _unverified_ in the old record). Alias `--yolo`
  (`shared_options.rs:52-59`).

For an already-containerised run `--dangerously-bypass-approvals-and-sandbox` is
strictly better than `-s danger-full-access`, for three reasons, all in
`codex-rs/exec/src/lib.rs`:

1. it forces `SandboxMode::DangerFullAccess` (`lib.rs:289-293`);
2. it implies `--skip-git-repo-check` (`lib.rs:755-763`);
3. it is passed as `preserve_headless_approval_policy` into `build_exec_config`
   (`lib.rs:437-442`, fn at `571-604`). **Without it**, if any config layer
   resolves `approvals_reviewer = "auto_review"`, exec discards the headless
   `Never` policy and falls back to `on-request` - which in exec mode is a
   guaranteed failure (see below). The crate's own test
   `exec_bypass_preserves_never_for_auto_review_config`
   (`codex-rs/exec/tests/suite/approval_policy.rs`) asserts exactly this.

Do not combine it with `--approve-for-me`, which is declared
`conflicts_with_all = ["sandbox_mode", "dangerously_bypass_approvals_and_sandbox"]`
(`shared_options.rs:44-50`).

**2. Exit codes - 0, 1 or 2 only; a refusal exits 0; a sandbox denial exits 0.**

The entire logic is `codex-rs/exec/src/lib.rs:1026-1034`:

```rust
event_processor.print_final_output();
if error_seen {
    std::process::exit(1);
}
Ok(())
```

`error_seen` is set in exactly three places (source comment at `lib.rs:927-928`:
"Track whether a fatal error was reported by the server so we can exit with a
non-zero status for automation-friendly signaling"): a non-retryable
`ServerNotification::Error` (`lib.rs:969-975`); a `TurnCompleted` whose
`TurnStatus` is `Failed` or `Interrupted` (`lib.rs:976-986`); and any
`handle_server_request` returning `Err` (`lib.rs:1783-1786`).

| Situation                                                                                                                                          | Exit     |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Turn completes - **including a model refusal, and including commands the sandbox denied**                                                          | **0**    |
| Turn `Failed` or `Interrupted`; non-retryable server error; API/auth failure; **any approval request raised**; a `required = true` MCP server down | 1        |
| Startup failure (bad config, bad `-c`, bad `.rules`, unreadable `--output-schema`, no prompt, not in a git repo without `--skip-git-repo-check`)   | 1        |
| CLI parse error (unknown flag, bad enum value)                                                                                                     | 2 (clap) |

- **Refusal → 0, definitively.** There is no refusal handling in the codebase at
  all: `grep -rn -i "refusal" codex-rs/ --include=*.rs` outside tests returns a
  single TUI feedback-form string. A refusal is an ordinary `agent_message`, the
  turn ends `Completed`, `error_seen` stays false.
- **Sandbox denial → 0.** `SandboxErr::Denied` is turned into tool output for the
  model and the turn continues (`codex-rs/core/src/tools/events.rs:407-421`). It
  shows up in JSONL as a `command_execution` item with `"status": "failed"`, but
  the process still exits 0.
- **Codex never hangs on a human.** `handle_server_request`
  (`lib.rs:1646-1787`) rejects every approval/elicitation request with e.g.
  "command execution approval is not supported in exec mode for thread …", and a
  failed rejection sets `error_seen`. That is why an accidental fallback to
  `on-request` is fatal rather than hanging.
- Observed (`docker run --rm --entrypoint sh e-harness-codex:latest -c 'codex
exec --skip-git-repo-check "say hi" ; echo "exit=$?"'`): 401 Unauthorized,
  **exit=1**, after ~7 s of WebSocket/HTTPS retries. The crate's regression test
  `codex-rs/exec/tests/suite/server_error_exit.rs` asserts `.code(1)` with the
  comment "so automation can detect failures".
- There is **no turn or iteration cap** in Codex; context pressure is handled by
  auto-compaction (`core/src/compact_remote.rs` and friends). If `e` wants a cap
  it must impose one itself.

No exit-code table is published anywhere - not in `docs/`, not on
learn.chatgpt.com. The non-zero-on-failure contract lives in the code and its
integration tests.

**3. Structured output - the best completion signal of the four.**

`--json` emits JSONL on stdout, defined in `codex-rs/exec/src/exec_events.rs`
(`ThreadEvent`, `#[serde(tag = "type")]`): `thread.started` (`thread_id`),
`turn.started`, `turn.completed` (`usage`), `turn.failed` (`error.message`),
`item.started` / `item.updated` / `item.completed` (`item: {id, type, …}`), and
`error` (`message`). `item.type` ∈ `agent_message{text}`, `reasoning{text}`,
`command_execution{command, aggregated_output, exit_code, status}`,
`file_change{changes, status}`, `mcp_tool_call`, `collab_tool_call`,
`web_search`, `todo_list`, `error{message}`.

**`turn.completed` carries no status field - its presence is the verdict.** The
mapping in `event_processor_with_jsonl_output.rs:513-553`: `Completed` emits
`turn.completed`, `Failed` emits `turn.failed`, and **`Interrupted` emits
nothing** (L547-551) while still setting `error_seen`. A JSONL-only consumer can
therefore see neither event on an interrupt - the exit code must stay primary.

`-o/--output-last-message <FILE>` is the cleanest signal available to `e`:
`print_final_output` writes the file only when `emit_final_message_on_shutdown`
is set, which happens **only** on `TurnStatus::Completed` (L520; explicitly false
on Failed L528 and Interrupted L549). So _file written ⇔ turn completed_. Two
caveats: on failure the file is **not touched**, so a stale file from a previous
run survives and `e` must delete it first; and a completed turn with no agent
message writes an empty file plus a stderr warning (`event_processor.rs:31-40`).

`--output-schema <FILE>` is how to get a _semantic_ verdict: `AgentMessageItem`
is documented as "Either a natural-language response or a JSON string when
structured output is requested" (`exec_events.rs:108-110, 135-140`). Forcing a
schema such as `{"status": "success" | "failure", "reason": "…"}` and reading it
back from `-o` turns "the turn ran" into "the task was done".

**4. TTY - not required; the hazard is stdin.** All runs above used `docker run`
with neither `-t` nor `-i` and behaved correctly. `isatty` is used only for
cosmetics and stdin mode. One useful side effect
(`event_processor_with_human_output.rs:396-397, 509-521`):
`should_print_final_message_to_stdout = final_message.is_some() &&
!(stdout_is_terminal && stderr_is_terminal)` - **in a non-TTY container run the
final agent message _is_ printed to stdout**, which is exactly what `e` wants.

The hazard: even when a PROMPT argument is given, `resolve_prompt`
(`lib.rs:1944-1964`) still calls `read_prompt_from_stdin(OptionalAppend)`, which
returns early only if stdin is a terminal (`lib.rs:1902`); otherwise it prints
`Reading additional input from stdin...` and blocks on `read_to_end`
(`lib.rs:1908-1912`). `e` is safe today - a one-shot `docker run` without `-i`
gives the container a `/dev/null` stdin that EOFs immediately - but the same
landmine as opencode's is waiting if `-i` is ever added.

**5. Session continuation.** `codex exec resume [SESSION_ID|--last] [PROMPT]`
(`codex-rs/exec/src/cli.rs:147-224`) is the only headless-usable one; the resume
handle is the `thread_id` from the first JSONL line. Top-level `codex resume` and
`codex fork` are **TUI-only** (`codex-rs/cli/src/main.rs:184-197`), and **there is
no `codex exec fork`**. `--ephemeral` makes resume impossible. Recorded for
completeness.

_Unverified for Codex_: the path taken when auto-compaction ultimately fails is
inferred (server error or `TurnStatus::Failed` → exit 1), not traced to an
explicit source line. Also note the official CLI reference at
`https://learn.chatgpt.com/docs/developer-commands?surface=cli` is **stale**: it
still documents `--ask-for-approval` and `--full-auto` on `codex exec`, both of
which the 0.147.0 binary rejects. Trust the binary and the tagged source, not
that page.

---

## What this means for `e`

### 1. Two harnesses need an argv change; one is actively broken

| Harness         | Change                                                                                                                                                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Codex**       | `['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', …, prompt]`. **This is a bug fix, not an enhancement** - today Codex runs in a read-only sandbox, cannot edit the worktree, and exits 0 anyway. Keep the prompt last (`harness.test.ts:165` asserts that, and `codex exec [OPTIONS] [PROMPT]` allows it). |
| **opencode**    | `['opencode', 'run', '--auto', prompt]`. Without it, anything resolving to `ask` - notably `external_directory` for any path outside cwd, and `.env` reads - is silently auto-rejected, producing exit 0 with empty stdout.                                                                                                |
| **Claude Code** | No change required. `--permission-prompts none` is an optional clarity win; `--bare` is worth considering separately (see §4).                                                                                                                                                                                             |
| **pi**          | No change required. `--approve`/`-a` only if `e` wants the run's own repo to supply `.pi/*` resources and project skills.                                                                                                                                                                                                  |

### 2. The exit code is not a verdict, on any harness

Every harness exits 0 when the model refuses, when a guardrail blocks a tool, and
(pi, Codex) when the context runs out or the last message is an unfinished tool
call. `runSpawn.ts:499` treats `exitCode === 0` as "the agent did the work". That
is wrong on all four, and the map's loop design makes it matter: a loop that
re-prompts on a _non-zero_ exit will never re-prompt a refusal, and a loop that
commits on a _zero_ exit will commit a half-finished tree.

This is the strongest argument in this research for the decision the map has
already taken - **the verify command's exit code is the verdict, not the
harness's**. The harness exit code should be demoted to what it actually is:

- **non-zero ⇒ the run definitely failed** (infrastructure, auth, bad argv,
  interrupted). Reliable on all four; safe to short-circuit on.
- **zero ⇒ the process finished; nothing more.** Not evidence of work.

### 3. Structured output is available but uneven, and pi's has a trap

If `e` ever wants a second, cheaper signal before running the verify container:

- **Codex is the best served.** `-o <file>` is written _if and only if_ the turn
  completed; combined with a forced `--output-schema` it yields a real
  pass/fail. Requirement: `e` must delete the file before each run, because on
  failure Codex does not touch it and a stale file would read as success.
- **Claude Code** gives `is_error`, `stop_reason` (`"refusal"`),
  `permission_denials` and `structured_output` in one JSON object - but gate on
  `is_error`, never on `subtype`, which can read `"success"` while `is_error` is
  true.
- **opencode** has no result envelope at all; the only trace of a blocked run is
  a `tool_use` line with `part.state.status == "error"`.
- **pi's structured mode is a downgrade**: `--mode json` bypasses the exit-code
  block entirely (`print-mode.js`, the check is inside `if (mode === "text")`),
  so adopting it would mean losing even the error/abort signal pi has today.

None of this changes the map's decision; it just says that if a pre-verify signal
is ever wanted, it is per-harness work, not one abstraction.

### 4. Things that are not about exit codes but showed up while looking

- **TTY is required by none of the four**, and `e` already spawns one-shot runs
  without `-i`/`-t`. Nothing to do.
- **Both Codex and opencode read stdin to EOF when stdin is not a TTY**, even
  when the prompt is an argv argument (`lib.rs:1908-1912`; `run.ts:416`). `e` is
  safe only because it passes no `-i`. If a future change ever adds `-i` - a
  streaming-input feature, say - both harnesses will hang before contacting the
  API. Worth a comment at the spawn site.
- **Claude Code runs an untrusted repo's hooks.** Without `--bare`, a `-p`
  session "runs the hooks in a project's `.claude/settings.json` and connects the
  servers in its `.mcp.json`, even in a folder you've never trusted"
  (`headless.md`). `e` mounts an arbitrary repo at `/workspace`, so a hostile
  repo can currently execute hooks inside the run container. That is a
  security-surface question for `docs/security/attack-surface.md`, not for this
  ticket, but it is a real finding.
- **opencode's `--share` publishes the session publicly** at `opncd.ai/s/<id>`
  (`share.mdx`). It must never be enabled by accident in an autonomous run, and
  `e` should make sure `OPENCODE_AUTO_SHARE` is not inherited into the container.
- **No harness pins its version.** `renderDockerfile.ts` runs
  `npm install -g <package>`, so every image rebuild adopts whatever is latest.
  Codex has already removed a flag (`--full-auto`) between the last research pass
  and this one; opencode's load-bearing flags are `hidden` aliases away from
  being renamed. If `e` is going to depend on these flags for unattended
  correctness, a pin (or a build-time `--help` assertion) is the cheap insurance.
- **Codex has no turn cap.** There is no `--max-turns` equivalent; context
  pressure is absorbed by auto-compaction. Claude Code has `--max-turns` and
  `--max-budget-usd`; pi and opencode have neither. The map's per-iteration
  wall-clock cap is therefore the only cross-harness bound, which argues for
  enforcing it host-side rather than hoping the harness stops.
