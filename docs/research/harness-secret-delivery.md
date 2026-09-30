# Harness secret delivery - keys and MCP headers by name, and what gets persisted

Question: **can `e` keep every secret (the provider API key, above all the
per-run OmniRoute key of ADR-0016 section 13, and MCP auth header values) out
of every file and image layer it renders, delivering values only as runtime env
vars (`--env-file` from a scratch dir) and naming them in config?** Today it
cannot for pi: `renderPiModelsJson` resolves `apiKeyEnv` from `.e/.env` and
writes the **value** into `models.json`, which is baked into the derived image
([`src/core/harness/adapter.ts`](../../src/core/harness/adapter.ts),
ADR-0006's "pi exception"). And the remote-MCP `headers` a user writes with
`${VAR}` ([`src/core/mcp/index.ts`](../../src/core/mcp/index.ts)) are passed
verbatim to every harness, whatever syntax that harness actually expands.

Gathered 2026-09-30. Every claim cites its primary source: each project's
source at the exact version `e` pins
([`src/core/harness/index.ts`](../../src/core/harness/index.ts)), its official
docs, or the shipped npm package. Where a claim rests on a measurement it says
**measured**: the pinned CLI was run in a scratch dir with a scratch `HOME`
against a local HTTP stub that logs the headers it receives, with fake secret
values, and the scratch dirs were then grepped for those values. Claims that
could not be confirmed from a primary source are marked _unverified_.

**Pinned sources:**

| Harness        | Version `e` pins / installs                                  | Source used                                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pi             | `@earendil-works/pi-coding-agent@0.99.0`                     | [`earendil-works/pi`](https://github.com/earendil-works/pi) tag `v0.99.0`, commit [`4b060d3a`](https://github.com/earendil-works/pi/tree/4b060d3a98618019adb9985d517516c8e99a2bbe) (the npm `gitHead` of 0.99.0; `packages/coding-agent`)                             |
| pi-mcp-adapter | unpinned `pi install npm:pi-mcp-adapter` -> latest **3.3.0** | [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) tag `v3.3.0`, commit [`9a747ce9`](https://github.com/nicobailon/pi-mcp-adapter/tree/9a747ce9bcdc72879c2cd3344879cf5821bd9bdd) (npm `gitHead` of 3.3.0, published 2026-09-29)              |
| Claude Code    | `@anthropic-ai/claude-code@2.1.284`                          | closed source: official docs at `code.claude.com/docs/en/{mcp,env-vars,cli-reference}` (unversioned, read 2026-09-30) and the shipped binary `@anthropic-ai/claude-code-linux-x64@2.1.284`; claims read from its minified code are marked _inference from the binary_ |
| Codex          | `@openai/codex@0.159.0`                                      | [`openai/codex`](https://github.com/openai/codex) tag `rust-v0.159.0`, commit [`687a119f`](https://github.com/openai/codex/tree/687a119f0fcaace47e1f1abcc77cec6c813fd6da) (the Rust tag matching the npm version, by the project's release convention)                |
| opencode       | `opencode-ai@1.18.33`                                        | [`anomalyco/opencode`](https://github.com/anomalyco/opencode) (the repo `sst/opencode` redirects to) tag `v1.18.33`, commit [`51ef4be1`](https://github.com/anomalyco/opencode/tree/51ef4be1d3c122f18fefb510dca8d778571f4f18)                                         |

All GitHub links below are permalinks into those commits.

## Answers at a glance

| Harness                 | Key by name?                                                                            | Exact syntax                                                                                                                     | MCP header by name?                                                                                                             | Exact syntax                                                                                                                                                          | Persists secrets?                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pi** 0.99.0           | **Yes.** ADR-0006's exception is obsolete. A **bare name is a literal** (since 0.77.0). | `models.json` `"apiKey": "${NAME}"` or `"$NAME"`; also `"!command"`. Unset/blank -> provider unusable, `No API key found for e.` | **Yes.** e's `mcp.json` is read by pi's **built-in** MCP (new in 0.99.0), not by pi-mcp-adapter (which ignores it since 3.0.0). | `mcp.json` header values `${NAME}` / `$NAME` / `!command`, templated inside text. Unset -> that server fails to connect, others still do.                             | **No** (measured): session JSONL, `auth.json` (`{}`), `models-store.json` hold no value. Only `/login` writes keys to `auth.json`.                                                                   |
| **Claude Code** 2.1.284 | **Yes**, env only (no config file involved).                                            | `ANTHROPIC_AUTH_TOKEN` (-> `Authorization: Bearer`) or `ANTHROPIC_API_KEY` (-> `X-Api-Key`), with `ANTHROPIC_BASE_URL`.          | **Yes** (measured on `--mcp-config`), **except** Claude's own and other known credential names, which read as empty.            | `${VAR}` / `${VAR:-default}` in `url` and `headers`. Unset, no default -> sent as literal `${VAR}` text.                                                              | **No** (measured) with `-p`. `~/.claude.json` `customApiKeyResponses` stores the **last 20 chars** of `ANTHROPIC_API_KEY`, but only after an interactive approval; never for `ANTHROPIC_AUTH_TOKEN`. |
| **Codex** 0.159.0       | **Yes.**                                                                                | `[model_providers.<id>] env_key = "NAME"`. Unset/blank -> ``Missing environment variable: `NAME`.``                              | **Yes, but not via `http_headers`**, which is literal (measured: `${VAR}` sent verbatim).                                       | `bearer_token_env_var = "NAME"` (Authorization: Bearer; unset -> error) and `env_http_headers = { "<Header>" = "NAME" }` (whole value only; unset -> header dropped). | **Yes, in `$CODEX_HOME/shell_snapshots/*.sh`** (measured: `declare -x NAME="<value>"` for every env var). Outside the mounted `sessions/`. Rollouts, `auth.json`: no.                                |
| **opencode** 1.18.33    | **Yes.**                                                                                | `provider.<id>.options.apiKey: "{env:NAME}"` (textual, whole file). Unset -> empty string, silently.                             | **Yes** (measured), but only in opencode's own syntax; `${VAR}` is sent verbatim (measured). No MCP overlay wired in `e` yet.   | `mcp.<name>.headers: { "Authorization": "Bearer {env:NAME}" }`, `type: "remote"`. Unset -> empty string, silently.                                                    | **No** (measured). The mounted `opencode.db` has `credential` and `account` tables, but 0 rows; they are filled only by in-app connect flows.                                                        |

**Verdict: every harness can take the provider key by name, and every harness
can take MCP header secrets by name in its own syntax.** No harness forces a
value into a file. Two changes are required (pi's `models.json`, Codex's
`http_headers`), two are hardening (Codex shell snapshots, Claude's
credential-name blanking). Details and snippets are in [Verdict](#verdict).

---

## pi 0.99.0

### Provider key by name

- **Resolver:** every `models.json` `apiKey` and header value goes through
  [`resolveConfigValue`](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/src/core/resolve-config-value.ts#L138-L151)
  (doc comment and body). Parsing
  ([L28-L86](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/src/core/resolve-config-value.ts#L28-L86)):
  - a value starting with `!` is a **shell command**; its trimmed stdout is the
    value (cached for the process in `resolveConfigValue`);
  - otherwise the value is a **template**: `$NAME` and `${NAME}` (NAME matching
    `^[A-Za-z_][A-Za-z0-9_]*$`,
    [L11](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/src/core/resolve-config-value.ts#L11))
    are env references and may sit inside literal text; `$$` escapes `$` and
    `$!` escapes `!`; `${...}` with an invalid name stays literal;
  - **everything else is a literal**. A bare `"E_KEY"` is sent as the string
    `E_KEY`: plain strings became literals in **0.77.0** ("treat plain strings
    as literals, support `$ENV_VAR` / `${ENV_VAR}` interpolation ... require
    explicit env syntax for config files",
    [CHANGELOG L1563](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/CHANGELOG.md#L1563)).
    **Measured:** `"apiKey": "E_KEY"` with `E_KEY` set sent `Authorization: Bearer E_KEY`.
- **Docs agree:** "`apiKey` and header values can use `$NAME` or `${NAME}`
  environment interpolation, a literal value, or a leading `!command`"
  ([`docs/models.md` L64](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/docs/models.md#L64)).
- **Where the value comes from:** the provider's auth context env
  ([`configContextEnv`](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/src/core/provider-composer.ts#L384-L396)),
  which is `process.env` and treats a blank or whitespace-only value as unset
  ([`packages/ai/src/auth/context.ts` L23-L28](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/ai/src/auth/context.ts#L23-L28));
  the template falls back to `process.env` with `||`, so an empty string also
  counts as unset
  ([L88-L90](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/src/core/resolve-config-value.ts#L88-L90)).
  The value is resolved **at request time**, not at load
  ([`docs/models.md` L64](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/docs/models.md#L64)).
- **Credential order:** runtime `--api-key`, then a stored `auth.json`
  credential, then `models.json` `apiKey`, then the provider's env vars
  ([`docs/models.md` L23](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/docs/models.md#L23);
  code: the `credential` branch precedes `rawKey` in
  [`composeApiKeyAuth`](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/src/core/provider-composer.ts#L398-L460)).
  In `e`'s image `auth.json` holds nothing, so `models.json` wins.
- **Unset variable:** the auth `check` returns "not configured" when any named
  var is unset
  ([L426-L432](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/src/core/provider-composer.ts#L426-L432)),
  so the model stays declared but unavailable ([`docs/models.md` L146](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/docs/models.md#L146));
  a request that reaches `resolve` throws `Failed to resolve API key for provider "e" from environment variable: NAME`
  ([L446-L448](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/src/core/provider-composer.ts#L446-L448),
  [`resolveConfigValueOrThrow`](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/src/core/resolve-config-value.ts#L229-L251)).
  **Measured:** `pi --no-approve -p hi --provider e --model m1` with
  `"apiKey": "${E_KEY}"` and `E_KEY` unset printed `No API key found for e.`
  and exited 1 with no request sent; with `E_KEY` set it sent
  `Authorization: Bearer <value>`.
- **Consequence for ADR-0006:** the stated reason for the exception ("pi
  selects only models declared in `models.json`") is still true, but it no
  longer forces the value into the file: the model stays declared, and only
  `apiKey` becomes a reference.

### MCP headers by name

- **pi 0.99.0 ships MCP as a built-in extension** ("Added codemode, tool
  search, and MCP support as built-in extensions ... MCP servers ... come from
  `mcp.json`",
  [CHANGELOG L3, L15](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/CHANGELOG.md#L15)).
  It reads `<agent dir>/mcp.json` (and a trusted project's `.pi/mcp.json`)
  ([`extensions/mcp/config.ts` L100-L101](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/src/extensions/mcp/config.ts#L100-L101)),
  which is exactly where `e` mounts its overlay (`piAdapter.planConfigOverlay`,
  `~/.pi/agent/mcp.json`). `harness-cli-facts.md` ("pi: MCP not supported",
  from 0.84.1) is stale on this point.
- **pi-mcp-adapter no longer reads that file.** Since 3.0.0: "The adapter no
  longer reads `<Pi agent dir>/mcp.json` or `.pi/mcp.json`. Those files now
  belong to Pi's built-in MCP support. Rename yours to `mcp-adapter.json`"
  ([CHANGELOG L99-L106](https://github.com/nicobailon/pi-mcp-adapter/blob/9a747ce9bcdc72879c2cd3344879cf5821bd9bdd/CHANGELOG.md#L99-L106);
  [README L58, L111-L114](https://github.com/nicobailon/pi-mcp-adapter/blob/9a747ce9bcdc72879c2cd3344879cf5821bd9bdd/README.md#L58);
  its global file is `getAgentPath("mcp-adapter.json")`,
  [`config.ts` L184-L186](https://github.com/nicobailon/pi-mcp-adapter/blob/9a747ce9bcdc72879c2cd3344879cf5821bd9bdd/config.ts#L184-L186)).
  pi's docs say an extension that registers `/mcp` replaces the built-in
  ([`docs/mcp.md` L184](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/docs/mcp.md#L184)),
  but the adapter registers `/mcp` only when it does **not** detect pi's
  built-in command
  ([`index.ts` L61-L65, L1083-L1088](https://github.com/nicobailon/pi-mcp-adapter/blob/9a747ce9bcdc72879c2cd3344879cf5821bd9bdd/index.ts#L1083-L1088)).
  So with 0.99.0 + adapter 3.3.0 the built-in keeps `mcp.json`.
  **Measured:** with `pi install npm:pi-mcp-adapter@3.3.0` in the scratch
  agent dir and `e`'s `mcpServers` shape in `mcp.json`, the stub MCP server
  received one connection carrying the expanded header.
  The comments on `renderPiMcpServers` / `piAdapter` in `adapter.ts` that
  credit pi-mcp-adapter are therefore wrong at these versions.
- **Built-in header syntax:** HTTP headers go through
  [`resolveHeadersOrThrow`](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/src/extensions/mcp/runtime.ts#L101-L106),
  the same resolver as provider keys: `${NAME}`, `$NAME`, `!command`, with
  literal text around references ("Keep secrets out of the file: use `${NAME}`
  ... as in `"Authorization": "Bearer ${GITHUB_TOKEN}"`",
  [`docs/mcp.md` L27, L47](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/docs/mcp.md#L47)).
  An unset name throws for that server; "Invalid entries are skipped and
  reported; the other servers still connect"
  ([L48](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/docs/mcp.md#L48)).
  **Measured:** `"Authorization": "Bearer ${E_MCP}"` arrived as
  `Bearer <value>`. `e`'s verbatim `${VAR}` therefore already works for pi.
  One caveat: since `$NAME` is also a reference, a literal `$` in a
  user-written header value must be written `$$`.
- **pi-mcp-adapter syntax, for completeness** (it matters only for servers in
  the adapter's own files): `${VAR}`, `$env:VAR` and `{env:VAR}` in headers,
  a leading `!` runs a command, plus `bearerTokenEnv`
  ([`utils.ts` L136-L143, L166-L177, L270-L275](https://github.com/nicobailon/pi-mcp-adapter/blob/9a747ce9bcdc72879c2cd3344879cf5821bd9bdd/utils.ts#L136-L143);
  [README L355, L370](https://github.com/nicobailon/pi-mcp-adapter/blob/9a747ce9bcdc72879c2cd3344879cf5821bd9bdd/README.md#L355)).
  An unset var becomes an empty string silently (`environment[name] ?? ""`),
  except in `url`, which fails.

### Persistence

- **Sessions:** the header line records `type`, `version`, `id`, `timestamp`,
  `cwd`, `parentSession`
  ([`SessionHeader`](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/src/core/session-manager.ts#L43-L50));
  entries carry messages, tool results, and model changes by provider and
  model id
  ([`docs/session-format.md` L64-L103](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/docs/session-format.md#L64-L103)),
  never provider config or env.
- **`auth.json`:** created as `{}` when first touched
  ([`auth-storage.ts` L63-L66](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/src/core/auth-storage.ts#L63-L66));
  credentials are written only by explicit login/store operations. The docs
  point to the env route "where Pi should not write credentials"
  ([`docs/models.md` L21](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/docs/models.md#L21)).
- **Measured:** after a run with `apiKey: "${E_KEY}"` and an MCP header
  `${E_MCP}`, the agent dir held `models.json`, `mcp.json`, `auth.json`
  (`{}`), `models-store.json` and one session JSONL; none contained either
  value, with or without pi-mcp-adapter installed. The adapter's metadata cache
  (`mcp-cache.json`) would store only a SHA-256 over the resolved config
  ([`metadata-cache.ts` L85-L117](https://github.com/nicobailon/pi-mcp-adapter/blob/9a747ce9bcdc72879c2cd3344879cf5821bd9bdd/metadata-cache.ts#L85-L117)),
  and only for servers in the adapter's own files.
- **Tool output is not scrubbed:** pi's bash tool runs with `{...process.env}`
  ([`utils/shell.ts` L138-L150](https://github.com/earendil-works/pi/blob/4b060d3a98618019adb9985d517516c8e99a2bbe/packages/coding-agent/src/utils/shell.ts#L138-L150)),
  so a command that prints the env puts the key into the session transcript,
  and thus into the Store. No pi setting to exclude variables was found.

## Claude Code 2.1.284

### Provider key by name

- `ANTHROPIC_API_KEY` is sent as `X-Api-Key`; "In non-interactive mode (`-p`),
  the key is always used when present. In interactive mode, you are prompted
  to approve the key once". `ANTHROPIC_AUTH_TOKEN` is the `Authorization`
  value, prefixed with `Bearer ` (official
  [env-vars](https://code.claude.com/docs/en/env-vars) table). Base URL is
  `ANTHROPIC_BASE_URL`. `claudeCodeAdapter` already delivers
  `ANTHROPIC_AUTH_TOKEN` as a `fromEnv` entry, so no config file carries it.
  **Measured:** `ANTHROPIC_AUTH_TOKEN=<v>` with `ANTHROPIC_BASE_URL` at the
  stub produced `POST /v1/messages` with `Authorization: Bearer <v>`.

### MCP headers by name

- **Syntax:** `${VAR}` and `${VAR:-default}`, expanded in `command`, `args`,
  `env`, `url` and `headers`
  ([mcp, "Environment variable expansion in `.mcp.json`"](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json)).
  The docs name `.mcp.json`; for `--mcp-config` (what `renderMcpArgs` uses)
  the docs are silent. **Measured on 2.1.284:** `claude -p hi
--strict-mcp-config --mcp-config '<json>'` sent `Authorization: Bearer
${E_TEST_HDR}` as `Bearer <value>`. So `--mcp-config` expands too.
- **Unset, no default:** "the config still loads ... and uses the unexpanded
  `${VAR}` text as-is" (same page, "Unset variables without a default").
  **Measured:** `X-Test: ${E_UNSET_HDR}` arrived as the literal text.
- **Credential names read as empty toward a remote server:** "In a remote
  server's `url` and `headers`, Claude Code reads credential variables from
  your environment as empty rather than expanding them", covering Claude
  Code's own credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`), cloud
  provider credentials, and "other credentials your environment carries, such
  as `HTTPS_PROXY` and `NPM_TOKEN`"; "A name outside this set, such as
  `API_KEY`, expands as written. To give the server one of the covered
  credentials, copy it into a variable with a name of your own"
  ([mcp, "Credential variables that read as empty"](https://code.claude.com/docs/en/mcp#credential-variables-that-read-as-empty)).
  **Measured:** `Bearer ${ANTHROPIC_AUTH_TOKEN}` arrived as `Bearer` with no
  token; `${GITHUB_TOKEN}` and `${E_TEST_HDR}` expanded. The binary's
  expansion routine (`UW(...)`, the one that logs "never expanded toward a
  remote server") checks names against fixed lists plus patterns such as
  `CARGO_REGISTRIES_*_TOKEN` and `GIT_CONFIG_*`; the full set cannot be read
  reliably from minified code (_inference from the binary_, full list
  _unverified_). A name `e` invents (see Verdict) is outside every example.
- References stay unexpanded in `/mcp`, `claude mcp list` and `claude mcp get`
  (same page, "How references appear").

### Persistence

- **`~/.claude.json` `customApiKeyResponses`:** holds `approved`/`rejected`
  lists of **truncated keys**: the binary computes `e.trim().slice(-20)` of
  `ANTHROPIC_API_KEY` and appends it when the interactive onboarding
  "ApproveApiKey" step or the settings toggle is answered; the step is shown
  only when `ANTHROPIC_API_KEY` is set and its suffix is "new"
  (_inference from the binary_). Nothing is stored for
  `ANTHROPIC_AUTH_TOKEN`. **Measured:** a `-p` run with
  `ANTHROPIC_AUTH_TOKEN` and one with `ANTHROPIC_API_KEY` each left
  `~/.claude.json`, its backup, `~/.claude/projects/-<cwd>/<id>.jsonl` and
  `~/.cache/claude-cli-nodejs/.../mcp-logs-*` without any of the values (and
  without a `customApiKeyResponses` entry). Interactive TUI runs
  (`buildInteractiveCommand`) with `ANTHROPIC_API_KEY` would write the 20-char
  suffix to `~/.claude.json`, which lives outside the mounted `projects/`.
- **Tool output:** the Bash tool inherits the env unless
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, which strips "Anthropic and cloud
  provider credentials, any other variable that Claude Code recognizes as a
  credential" from Bash, hooks and MCP stdio servers while the parent keeps
  them; on Linux it also runs Bash in an isolated PID namespace
  ([env-vars](https://code.claude.com/docs/en/env-vars)). Whether that
  namespace can be created inside `e`'s unprivileged container: **measured
  for #204, it cannot** under Docker's defaults; see
  [Claude Code 2.1.284 - measured for #204](#claude-code-21284---measured-for-204).

## Codex 0.159.0

### Provider key by name

- `env_key`: "Environment variable that stores the user's API key for this
  provider"; `experimental_bearer_token` (a literal) is "discouraged in favor
  of `env_key` for security reasons"
  ([`model-provider-info/src/lib.rs` L144-L153](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/model-provider-info/src/lib.rs#L144-L153)).
- Resolution: `std::env::var(env_key)`, a blank value counts as missing, and
  a missing one is `CodexErr::EnvVar`
  ([`api_key` L469-L489](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/model-provider-info/src/lib.rs#L469-L489)),
  printed as ``Missing environment variable: `NAME`.``
  ([`protocol/src/error.rs` L861-L866](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/protocol/src/error.rs#L861-L866)).
  This is what `renderCodexConfig` renders today. **Measured:** `env_key =
"E_KEY"` sent `Authorization: Bearer <value>` to `/v1/responses`.
- Provider `http_headers` are literal; `env_http_headers` maps a header to an
  env var name and drops the header when the var is unset or blank
  ([L165-L172](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/model-provider-info/src/lib.rs#L165-L172),
  [`build_header_map` L389-L414](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/model-provider-info/src/lib.rs#L389-L414)).

### MCP headers by name

- The streamable-HTTP transport has four header fields
  ([`config/src/mcp_types.rs` L636-L655](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/config/src/mcp_types.rs#L636-L655)):
  `bearer_token_env_var` ("The actual secret value must be provided via the
  environment"), `http_headers` (static), `env_http_headers` ("HTTP headers
  where the value is sourced from an environment variable"), and
  `http_headers_helper` (a local command; "do not embed credentials").
- **`http_headers` is literal:** each value goes straight into
  `HeaderValue::from_str`, no expansion
  ([`rmcp-client/src/utils.rs` L103-L128](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/rmcp-client/src/utils.rs#L103-L128)).
  **Measured:** `http_headers = { "Authorization" = "Bearer ${E_MCP}" }` (what
  `renderCodexMcpServers` emits for a user's `${VAR}` header) arrived as the
  literal `Bearer ${E_MCP}`. Today's Codex MCP auth is broken, not leaking.
- **`env_http_headers`:** header name -> env var **name**, whole value only; an
  unset or blank var skips the header silently
  ([L130-L159](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/rmcp-client/src/utils.rs#L130-L159)).
  There is no templating, so `Token ${X}` cannot be expressed by name.
- **`bearer_token_env_var`:** read with `env::var`; an unset or empty var is an
  error for that server ("Environment variable NAME for MCP server 'x' is not
  set")
  ([`codex-mcp/src/rmcp_client.rs` L872-L903](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/codex-mcp/src/rmcp_client.rs#L872-L903)).
  **Measured:** `bearer_token_env_var = "E_MCP"` plus `env_http_headers = {
"X-Test" = "E_MCP2" }` arrived as `Authorization: Bearer <value>` and
  `X-Test: <value2>`.

### Persistence

- **Rollouts** (`$CODEX_HOME/sessions`, `e`'s mount): `SessionMeta` records
  ids, `cwd`, `originator`, `cli_version`, the `model_provider` **id**,
  `base_instructions`, tools
  ([`protocol/src/protocol.rs` L3123-L3198](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/protocol/src/protocol.rs#L3123-L3198)),
  not provider config or env. **Measured:** no value in `sessions/`.
- **`auth.json`:** written only by `save_auth` from the login functions
  (`login_with_api_key`, `login_with_access_token`,
  `login_with_chatgpt_auth_tokens`, external auth commit)
  ([`login/src/auth/manager.rs` L1022, L1047, L1129](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/login/src/auth/manager.rs#L1022)),
  never from `env_key`. **Measured:** no `auth.json` was created.
- **Shell snapshots write the whole env to disk.** The `shell_snapshot`
  feature is stable and on by default
  ([`features/src/lib.rs` L1010-L1015](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/features/src/lib.rs#L1010-L1015)),
  writes under `$CODEX_HOME/shell_snapshots` with a 3-day retention
  ([`core/src/shell_snapshot.rs` L105-L107](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/shell_snapshot.rs#L105-L107)).
  **Measured:** after `codex exec`, `shell_snapshots/<thread>.<n>.sh` held
  `declare -x E_KEY="<value>"`, `declare -x E_MCP="<value>"`, and every other
  var of the process. It is outside `sessions/`, so it dies with the `--rm`
  container and never reaches the Store, but it is a file carrying the
  secret. **Measured fixes:** `[features] shell_snapshot = false` produced no
  snapshot; `[shell_environment_policy] exclude = ["E_KEY"]` produced a
  snapshot without the value. In both runs the provider request still carried
  the key.
- **Tool output:** `shell_environment_policy` defaults to `inherit = "all"`
  with `ignore_default_excludes = true`
  ([`config/src/shell_environment_policy.rs` L134-L136](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/config/src/shell_environment_policy.rs#L134-L136)),
  so the default `*KEY*`/`*SECRET*`/`*TOKEN*` excludes are **off** and the
  agent's shell sees the key; custom `exclude` patterns apply regardless
  ([`protocol/src/shell_environment.rs` L123-L136](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/protocol/src/shell_environment.rs#L123-L136)).
  An explicit `exclude` keeps the key out of shell output and thus out of the
  rollout.

## opencode 1.18.33

### Provider key by name

- `{env:VAR}` is substituted **textually over the whole config file** before
  it is parsed; an unset or empty var becomes `""`
  ([`config/variable.ts` L33-L38](https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/opencode/src/config/variable.ts#L33-L38),
  applied in
  [`loadConfig` L227-L241](https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/opencode/src/config/config.ts#L227-L241)).
  Docs: "If the environment variable is not set, it will be replaced with an
  empty string"
  ([`config.mdx` L898-L917](https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/web/src/content/docs/config.mdx#L898-L917)).
  This is what `renderOpencodeConfig` renders. An empty `apiKey` is still a
  defined option (opencode fills `apiKey` from stored auth only when it is
  `undefined`,
  [`provider.ts` L1832](https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/opencode/src/provider/provider.ts#L1832)),
  so a missing key surfaces as the endpoint's 401 (the AI SDK's handling of
  `""` is _unverified_). **Measured:** `"apiKey": "{env:E_KEY}"` sent
  `Authorization: Bearer <value>`.
- The substitution is not JSON-escaped (unlike `{file:}`), so a value with `"`
  or `\` would break the file. Irrelevant for API keys.

### MCP headers by name

- The same textual substitution covers `mcp.<name>.headers`; the docs show
  `"Authorization": "Bearer {env:MY_API_KEY}"` with `"oauth": false` "for
  servers that use API keys instead"
  ([`mcp-servers.mdx` L245-L262](https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/web/src/content/docs/mcp-servers.mdx#L245-L262)).
  **Measured:** `"Authorization": "Bearer {env:E_MCP}"` arrived expanded;
  `"X-Test": "${E_MCP}"` arrived as the literal `${E_MCP}`. `e` wires no
  opencode MCP overlay yet (`opencodeAdapter` has no `planConfigOverlay`); when
  it does, `${VAR}` must be rewritten to `{env:VAR}`.

### Persistence

- **`opencode.db`** (`OPENCODE_DB`, `e`'s mount): besides session, message and
  part tables it defines a `credential` table (`value` JSON) and an `account`
  table (`access_token`, `refresh_token`)
  ([`core/src/credential/sql.ts`](https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/core/src/credential/sql.ts#L5-L14),
  [`core/src/account/sql.ts` L6-L14](https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/core/src/account/sql.ts#L6-L14)).
  `credential` rows are created only by the integration connect flows, an
  OAuth settle or an explicit key connection
  ([`core/src/integration.ts` L335-L339, L404-L418](https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/core/src/integration.ts#L404-L418)),
  never from `{env:}` config. The `index.ts` comment that the mount "holds the
  conversation, never the credential files" is true for the files; the db
  merely has empty credential tables. **Measured:** after `opencode run`, the
  db (with `-wal`/`-shm`) held 1 session, 2 messages, 1 part, **0**
  `credential` and **0** `account` rows, and no value anywhere in it or in the
  scratch `HOME`.
- **`auth.json`** (`<data dir>/auth.json`) and **`mcp-auth.json`** are written
  by `opencode auth login` and MCP OAuth
  ([`auth/index.ts` L10, L79, L88](https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/opencode/src/auth/index.ts#L79);
  [`mcp/auth.ts` L37](https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/opencode/src/mcp/auth.ts#L37)).
  Without `"oauth": false`, a remote server that answers 401 may start an OAuth
  flow; in a headless run that is a failure, not a write (_unverified_).
- The only config write-back at load inserts `$schema` into the **raw**
  (unsubstituted) text
  ([L244-L249](https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/opencode/src/config/config.ts#L244-L249)),
  and `e` renders `$schema` already.

---

## Verdict

**Every secret can stay out of every file.** The provider key is referenced by
name on all four harnesses, MCP header secrets on all four (each in its own
syntax), and the only file a harness writes with values in it (Codex's shell
snapshot) can be switched off. The per-run OmniRoute key then exists only in
the scratch `--env-file` and in the container's process env, so ADR-0016
section 13's "pi carries the run key in its derived image and in the Base
Store's scratch `models.json`" goes away, and the pi derived image stops
changing with every run key (inference: the baked file no longer contains a
per-run value).

One caveat holds everywhere: the agent's shell inherits the process env, and
every harness records tool output in its session. A command that prints the
env writes the key into the session dir `e` keeps in the Store. Claude
(`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`) and Codex (`shell_environment_policy`)
can hide it from the shell; pi and opencode have no such setting.

### pi - `renderPiModelsJson`, `piAdapter`

Render the key as a reference, never the value:

```json
{
  "providers": {
    "e": {
      "baseUrl": "https://gateway.example.com/v1",
      "api": "openai-completions",
      "apiKey": "${OMNIROUTE_RUN_KEY}",
      "models": [{ "id": "<model>" }]
    }
  }
}
```

- `"apiKey": "${<apiKeyEnv>}"`, **with the braces**: a bare `"<apiKeyEnv>"`
  is a literal at 0.99.0. Drop `storeEnv[provider.apiKeyEnv]` from
  `renderPiModelsJson`; keep `runtimeEnv: [{ name: apiKeyEnv, fromEnv:
apiKeyEnv }]` in `piAdapter.planProviderDelivery`, which already makes the
  var present at run time. Reject an `apiKeyEnv` that does not match
  `^[A-Za-z_][A-Za-z0-9_]*$`, since pi would keep `${...}` literal. `storeEnv`
  is then only needed for `baseUrlEnv`, a non-secret.
- MCP: keep `renderPiMcpServers` passing `${VAR}` through; pi's built-in MCP
  expands it. Fix the comments that credit pi-mcp-adapter, and decide whether
  to keep `pi install npm:pi-mcp-adapter` at all: it is unpinned in
  `HARNESSES.pi.dockerfile.setupSteps`, and since 3.0.0 it no longer serves
  `e`'s `mcp.json`.
- Update ADR-0006 (drop the pi exception), ADR-0016 section 13 (the image no
  longer carries the run key), the `FileHarnessAdapter.planProviderDelivery`
  doc (`storeEnv` "for a file format that cannot reference a key by name
  (pi)"), and `harness-cli-facts.md` (pi now has MCP; bare `apiKey` is
  literal), plus the `adapter.test.ts` expectations.

### Claude Code - `claudeCodeAdapter`, `renderMcpArgs`

- Provider: unchanged (`ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` values,
  `ANTHROPIC_AUTH_TOKEN` `fromEnv`). No file involved.
- MCP: `--mcp-config` expands `${VAR}`, and argv carries only the name, so the
  verbatim pass-through is sound, **except** for names Claude treats as
  credentials (`ANTHROPIC_*` keys, `NPM_TOKEN`, cloud credentials, ...), which
  arrive empty. So that `e` never depends on the exact set, rename every
  referenced var when it renders: deliver the value under an `e`-owned name in
  the server's credential env-file (`renderMcpCredentials`) and rewrite the
  reference, for example

  ```json
  {
    "type": "http",
    "url": "https://mcp.example.com/mcp",
    "headers": { "Authorization": "Bearer ${E_MCP_GITHUB_TOKEN}" }
  }
  ```

  where `E_MCP_GITHUB_TOKEN` carries the value of the user's `GITHUB_TOKEN`
  (`{ name: "E_MCP_GITHUB_TOKEN", fromEnv: "GITHUB_TOKEN" }`). The prefix is a
  choice to measure once against 2.1.284, since the binary's pattern list is
  not fully readable. **Measured for #204:** use an index, `E_MCP_<n>`, not
  the source name; see
  [Claude Code 2.1.284 - measured for #204](#claude-code-21284---measured-for-204).

- Hardening: add `{ name: "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", value: "1" }` to
  `renderProviderEnv`, after checking that its PID namespace works in `e`'s
  container. **Measured for #204: do not**; it fails in the container and
  disables `--dangerously-skip-permissions` (same section).

### Codex - `renderCodexConfig`, `renderCodexMcpServers`

- Provider: unchanged (`env_key = "<apiKeyEnv>"`).
- MCP: **`renderCodexMcpServers` must stop emitting `${VAR}` inside
  `http_headers`**; translate each header:

  ```toml
  [mcp_servers.github]
  url = "https://mcp.example.com/mcp"
  bearer_token_env_var = "GITHUB_TOKEN"                 # "Authorization": "Bearer ${GITHUB_TOKEN}"
  env_http_headers = { "X-Api-Key" = "X_API_KEY" }      # "X-Api-Key": "${X_API_KEY}"
  http_headers = { "X-Client" = "e" }                   # literal, no reference
  ```

  A value that is anything else (text around the reference, several
  references, such as `Token ${X}`) has no by-name form in Codex. Fallback,
  still no file: compose the full header value at spawn into an `e`-owned var
  (`{ name: "E_MCP_<SERVER>_H<n>", value: <rendered header> }` in the MCP
  credential env-file, resolved by `EnvFileRenderer`) and reference it with
  `env_http_headers = { "<Header>" = "E_MCP_<SERVER>_H<n>" }`. Note the
  asymmetry: an unset `bearer_token_env_var` fails the server, an unset
  `env_http_headers` var silently drops the header; `e`'s `requiredEnv`
  fail-loud covers both.

- Required for "no file": append to `renderCodexConfig`

  ```toml
  [features]
  shell_snapshot = false

  [shell_environment_policy]
  exclude = ["<apiKeyEnv>", "<each MCP header var>"]
  ```

  The first stops the measured `declare -x <KEY>="<value>"` snapshot; the
  second keeps the key out of the agent's shell and so out of the rollout
  `e` keeps. Both were measured not to affect the provider's own
  authentication.

### opencode - `renderOpencodeConfig`, future `planConfigOverlay`

- Provider: unchanged (`"apiKey": "{env:<apiKeyEnv>}"`).
- MCP, when the overlay is wired: rewrite every `${VAR}` to `{env:VAR}` and set
  `"oauth": false` for header-authenticated servers:

  ```json
  "mcp": { "github": { "type": "remote", "url": "https://mcp.example.com/mcp",
    "oauth": false, "headers": { "Authorization": "Bearer {env:GITHUB_TOKEN}" } } }
  ```

  Deliver it like the provider file, under `OPENCODE_CONFIG_DIR`. An unset var
  becomes `""` silently, so `e`'s `requiredEnv` check stays the guard.

### Nowhere impossible

No harness requires a value in a file. The only gaps are expressiveness: Codex
cannot template around a reference, and Claude blanks some credential names.
Both close with the same fallback: an `e`-owned env var, delivered through the
scratch `--env-file` and referenced by name.

---

## Claude Code 2.1.284 - measured for #204

Measured 2026-09-30 for [#204](https://github.com/BelphegorPrime/e/issues/204):
which `${VAR}` references in a remote MCP header arrive empty, which `e`-owned
name is safe, and whether `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` belongs in
`claudeCodeAdapter.renderProviderEnv`.

**Pinned sources:**

| Package                                            | Integrity (npm lockfile)                                                                          | Used for                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `@anthropic-ai/claude-code@2.1.284`                | `sha512-IuENsoLa+Y5fx5VaP0Md3n5UO7aYxjbFE/iydSDw6tMo2171oaxaaBa9oIepPG9NILd1owSx74ozsqAkTbEOjw==` | wrapper that selects the native binary        |
| `@anthropic-ai/claude-code-linux-x64@2.1.284`      | `sha512-hjjPgN4u8DvnzZqWDYnU5xxQkykuUrkUoVeeutVLXjrhx4qeRPmwgZ69BFAHmV42FBRdiRwbLbiDE9nkQdAE8g==` | host runs; the source quotes below            |
| `@anthropic-ai/claude-code-linux-x64-musl@2.1.284` | `sha512-6oPajQ/DRftfQOJ330vrnXsQQ9CkwSz6DkjjurfWZClpNNZbOv186EYk9llMR3PiKOA9W05DiPW86nddsgtP7w==` | container runs (`node:24-alpine`, like `e`'s) |

2.1.284 ships no `cli.js`: the npm package is a wrapper (`cli-wrapper.cjs`)
plus a Bun-compiled binary whose JavaScript is embedded as plain text. The
code below was read from that text (`strings` on the binary) and is quoted by
its minified names, which change with every release (_inference from the
binary_ wherever a measurement does not back it).

**Method.** Claude was run the way `e` runs it: `buildCommand` plus
`renderMcpArgs`, that is `claude -p <prompt> --dangerously-skip-permissions
--strict-mcp-config --settings '{"disableAllHooks":true}' --mcp-config
'{"mcpServers":{"x":{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{...}}}}'`,
with stdin closed, and the env of `claudeCodeAdapter.renderProviderEnv`
(`ANTHROPIC_BASE_URL` at the stub, `ANTHROPIC_MODEL`, `ANTHROPIC_AUTH_TOKEN`
fake). Host runs used `env -i` with a scratch `HOME` (so the config home was
`<HOME>/.claude`); container runs used `docker run` with only the options
`buildRunArgs` emits (image `USER node`, default seccomp and AppArmor, no
added capabilities), `/workspace` and `~/.claude/projects` bind-mounted from
scratch dirs. One local Node stub served `POST /v1/messages` as SSE (text, or
a scripted `tool_use` for the Bash tool followed by text once a `tool_result`
came back) and a streamable-HTTP MCP endpoint (`initialize`, `tools/list`),
logging every request's headers. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
was set to keep the runs off the network; `e` does not set it. Host: Linux
7.1.5, bubblewrap 0.11.0, unprivileged user namespaces allowed, Docker 29.8.1.

### Which names read as empty in a remote MCP header

**Measured** (host; each header was `v=${VAR}`, each var set to a distinct
fake value, the provider key only as `ANTHROPIC_AUTH_TOKEN` plus, for this
table, a fake `ANTHROPIC_API_KEY`):

| Reference                                                | Arrived, scrub off (`e` today) | Arrived, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` |
| -------------------------------------------------------- | ------------------------------ | --------------------------------------------- |
| `${NPM_TOKEN}`                                           | `v=` (empty)                   | `v=`                                          |
| `${GITHUB_TOKEN}`                                        | value                          | value                                         |
| `${ANTHROPIC_API_KEY}`                                   | `v=`                           | `v=`                                          |
| `${ANTHROPIC_AUTH_TOKEN}`                                | `v=`                           | `v=`                                          |
| `${OPENAI_API_KEY}`                                      | value                          | `v=`                                          |
| `${AWS_SECRET_ACCESS_KEY}`                               | `v=`                           | `v=`                                          |
| `${MY_SERVICE_TOKEN}`                                    | value                          | `v=`                                          |
| `${E_MCP_GITHUB_TOKEN}`                                  | value                          | `v=`                                          |
| `${E_MCP_NPM_TOKEN}`                                     | value                          | `v=`                                          |
| `${E_MCP_X}`                                             | value                          | value                                         |
| `${E_MCP_0}`, `${E_MCP_V1}`                              | value                          | value                                         |
| `${E_MCP_GHP}` holding a `ghp_...`-shaped value          | value                          | value                                         |
| `Authorization: Bearer ${E_MCP_AUTHZ}`                   | `Bearer <value>`               | `Bearer <value>`                              |
| `${E_MCP_X}` holding `Bearer Abc0123456789defGHIJ`       | value                          | `v=`                                          |
| `${E_MCP_V1}` holding `https://user:pw...@example.com/x` | value                          | `v=`                                          |
| `${E_UNSET_VAR}` (unset)                                 | literal `v=${E_UNSET_VAR}`     | literal `v=${E_UNSET_VAR}`                    |

**Measured** in the container (scrub off): `${NPM_TOKEN}` arrived empty,
`${E_MCP_0}` and `${E_MCP_GITHUB_TOKEN}` with their values, `Bearer
${E_MCP_0}` as `Bearer <value>`: the same as on the host.

**Where the rule lives** (_inference from the binary_). Each header is
expanded at connect time by `TXt`, which calls `UW(value, void 0, void 0,
{remoteSink: !0, blankList: cV()})`; `UW` is the routine that logs
"references credential variable(s) that are never expanded toward a remote
server". A `${NAME}` reads as empty when any of these holds:

- **Fixed names, always** (`cV().remoteSink`, compared upper-cased, each also
  with an `INPUT_` prefix): Claude's own credentials (`H1t`, `r6e`:
  `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, the
  `*_FILE_DESCRIPTOR` vars, `MCP_CLIENT_SECRET`, `ENVIRONMENT_SERVICE_KEY`,
  ...); the `ho` list (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_FOUNDRY_API_KEY`,
  `ANTHROPIC_FOUNDRY_AUTH_TOKEN`, `ANTHROPIC_AWS_API_KEY`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `AZURE_CLIENT_SECRET`, ...); and `tln`:
  `AWS_CONTAINER_AUTHORIZATION_TOKEN`, `ANTHROPIC_IDENTITY_TOKEN`,
  `CLOUDSDK_AUTH_ACCESS_TOKEN`, `GOOGLE_OAUTH_ACCESS_TOKEN`,
  `AZURE_CLIENT_CERTIFICATE_PASSWORD`, `AZURE_PASSWORD`,
  `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`, `CLAUDE_CODE_CLIENT_KEY`,
  `CLAUDE_CODE_CLIENT_CERT`, `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` (and
  lower case), `CARGO_REGISTRY_TOKEN`, `NPM_TOKEN`, `CODEARTIFACT_AUTH_TOKEN`,
  `PIP_INDEX_URL`, `PIP_EXTRA_INDEX_URL`, `UV_INDEX_URL`, `UV_EXTRA_INDEX_URL`,
  `UV_DEFAULT_INDEX`, `UV_INDEX`, `GOPROXY`, `GOAUTH`, `PYPI_TOKEN`,
  `TWINE_PASSWORD`. `GITHUB_TOKEN` and `OPENAI_API_KEY` are on none of them,
  which matches the table.
- **Name patterns, always** (`Pge`, `Mge`): `^GIT_CONFIG_(?:PARAMETERS|(?:KEY|VALUE)_\d+)$`,
  `^CARGO_REGISTRIES_[A-Z0-9_]+_TOKEN$`, `OTEL_*`, `CLAUDE_CODE_ARTIFACT*_BASE_URL`,
  `^(?:INPUT_)?BUNDLE_..__` (`a1t`), user and password names under fixed
  prefixes (`l1t`, anchored `^(?:INPUT_|ORG_GRADLE_PROJECT_|POETRY_PYPI_TOKEN_|POETRY_HTTP_BASIC_|CARGO_REGISTRIES_|...)`),
  and an `ANTHROPIC_*_BASE_URL`-type name whose value carries credentials.
- **Only while the scrub is on** (`Ige`, gated by `qYn()`: true when
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is truthy, or when
  `CLAUDE_CODE_ENTRYPOINT=local-agent`): (a) every name the secret-name
  regex `Yt` matches, whole `_`-separated words `TOKEN`, `SECRET`,
  `PASSWORD`, `PASSWD`, `PASSPHRASE`, `KEY`, `AUTH`, `COOKIE`, `PAT`, `DSN`,
  `WEBHOOK`, `CREDENTIAL(S)`, `CREDS`, `APIKEY`, `ACCESSKEY`, ... plus
  `_PWD`, `_PASS`, `_JWT` and camelCase splits, except `GITHUB_TOKEN`,
  `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` (`QBo`); and
  (b) every value that looks like a credential (`aT`): a URL with userinfo,
  `Bearer <x>` / `Basic <x>` / `Token <x>`, `authorization: ...`,
  `password=...`-style pairs, a PEM private key, Slack/Discord/Teams webhook
  URLs.

So the earlier "credential names read as empty" is one fixed list plus
patterns while the scrub is off, and it grows to every secret-looking name
and value once the scrub is on.

### A safe `e`-owned name

- **`E_MCP_` itself is never blanked:** no fixed name starts with it, and
  every pattern above is anchored on another prefix. **Measured:**
  `E_MCP_GITHUB_TOKEN`, `E_MCP_NPM_TOKEN`, `E_MCP_X`, `E_MCP_0` all expanded
  with the scrub off, on the host and in the container.
- **The suffix decides once the scrub is on:** `E_MCP_GITHUB_TOKEN` and
  `E_MCP_NPM_TOKEN` then read as empty (**measured**), because `_TOKEN` is a
  secret word. The same would hit any suffix taken from user text: a server
  or var name containing `AUTH`, `KEY`, `PAT`, `TOKEN`, ...
- **Recommendation:** `E_MCP_<n>`, a decimal index assigned per referenced
  source var at render time (`E_MCP_0`, `E_MCP_1`, ...), never the source
  name or the server name. It contains no secret word, so it expands whether
  or not the scrub is ever turned on (**measured:** `E_MCP_0` and `E_MCP_V1`
  expanded in both columns). Keep the surrounding text in the header
  template (`"Authorization": "Bearer ${E_MCP_0}"`) and put only the bare
  secret in the var: a var whose value is itself `Bearer ...` or a URL with
  credentials reads as empty under the scrub (**measured**).

### `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`

- **Without it (`e` today), the key reaches the transcript.** **Measured:**
  the stub model called Bash with `env`; the tool result held
  `ANTHROPIC_AUTH_TOKEN=<fake>` (and every other var), and so did
  `<HOME>/.claude/projects/<cwd>/<session>.jsonl`, on the host and in the
  container's mounted `projects/-workspace/`.
- **It overrides `--dangerously-skip-permissions`.** **Measured:** with the
  scrub, Claude prints "Permission mode forced to default ... Declare
  allowedTools explicitly, or set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0 to opt
  out.", and the scripted Bash call came back as the error tool result "This
  command requires approval"; the run still exited 0. The binary's `NLr`
  returns mode `default` whenever the var is set, before it looks at
  `dangerouslySkipPermissions` or `--permission-mode` (_inference from the
  binary_). Adding `--allowedTools Bash` let Bash run (**measured**); other
  tools (Edit, Write, WebFetch, ...) would need the same (_unverified_).
- **When Bash does run, it hides the key and auth still works.**
  **Measured** (host, `--allowedTools Bash`): Bash ran as `bwrap
--new-session --die-with-parent ... --unshare-pid --unshare-user --cap-drop
ALL --proc /proc -- /bin/bash -c ...` (the shell was PID 2, 5 processes
  visible); `env` showed no `ANTHROPIC_AUTH_TOKEN`, `NPM_TOKEN`,
  `AWS_SECRET_ACCESS_KEY`, `OPENAI_API_KEY`, `MY_SERVICE_TOKEN`,
  `E_MCP_GITHUB_TOKEN`, `E_MCP_NPM_TOKEN`, but kept `GITHUB_TOKEN`,
  `ANTHROPIC_BASE_URL` and `E_MCP_0`/`E_MCP_X`/`E_MCP_V1`/`E_MCP_AUTHZ`; the
  session JSONL held no provider key. Every provider request, with and
  without the scrub, carried `Authorization: Bearer <fake>`.
- **It needs bubblewrap and socat.** **Measured** in the container: without
  `bwrap`, Claude exits 1 at startup with "bubblewrap is required for
  subprocess env scrubbing and isolation. ..."; with `bwrap` but without
  `socat`, every Bash call answers "Sandbox is required but failed to
  initialize: Sandbox dependencies not available: socat not installed." The
  `e` image installs neither (`apkPackages: ['bash']`).
- **It does not work in `e`'s container.** **Measured** (`node:24-alpine`
  plus `bash bubblewrap socat`, user `node`, default Docker options): Bash
  fails with "bwrap: No permissions to create a new namespace, likely because
  the kernel does not allow non-privileged user namespaces." (Docker's
  default seccomp profile refuses the user namespace, although the host
  allows it). `--security-opt seccomp=unconfined` moves the failure to
  "bwrap: Failed to make / slave: Permission denied"; adding
  `apparmor=unconfined` to "bwrap: Can't mount proc on /proc: Operation not
  permitted"; only with `systempaths=unconfined` as well did Bash run (PID 2,
  no key). Other engines and hosts (rootless Docker, Podman, other AppArmor
  policies) were not tried (_unverified_).
- **It writes into the workspace and freezes files there.** **Measured:** at
  startup with the scrub (`xWr`), Claude creates, when missing, empty
  `.env`, `.env.local`, `.env.development`, `.env.development.local`,
  `.env.test`, `.env.test.local`, `.env.production`, `.env.production.local`,
  `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `bunfig.toml`, `package.json`,
  `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `.gitmodules` and the
  dirs `.claude/commands`, `.claude/agents`, `node_modules/.bin` in the
  working directory (the same 19 entries appeared in the container's
  `/workspace`), plus `.gitconfig`, `.bashrc`, `.profile`, `.zshrc`,
  `.npmrc`, `.netrc`, ... in `HOME`. It binds them read-only into the Bash
  sandbox: `echo {} > package.json` failed with "Read-only file system",
  while a new file could be written; `.git` is masked by an empty read-only
  dir. Since `e` captures and commits `/workspace` after the run, those
  empty files would land in the run's commit (inference from `e`'s capture
  step, not run end to end).

### Permission mode

`buildCommand`, `resumeCommand` and `buildInteractiveCommand` all pass
`--dangerously-skip-permissions`. **Measured:** with it, the Bash tool ran
headless (`-p`, stdin closed, no prompt) on the host and as `node` in the
container. The scrub is the one setting found that silently turns this off
(above).

### Verdict for #204

- **Prefix:** deliver each var an MCP header references as `E_MCP_<n>`
  (decimal index, no user text), for example `{ name: 'E_MCP_0', fromEnv:
'NPM_TOKEN' }` in the server's credential env-file, and rewrite
  `${NPM_TOKEN}` to `${E_MCP_0}` in `renderMcpArgs`. **Measured:** a name of
  that shape reaches the server with its value, with or without the scrub,
  where `${NPM_TOKEN}` arrives empty. The issue's `E_MCP_GITHUB_TOKEN` form
  works too while the scrub stays off, but breaks as soon as it is on.
- **Scrub: do not add `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` to
  `claudeCodeAdapter.renderProviderEnv`.** It exits 1 without `bwrap` in the
  image, needs `socat`, cannot create its namespaces under Docker's defaults
  unless seccomp, AppArmor and the masked `/proc` paths are all lifted (a net
  loss of isolation for the whole container), forces the permission mode
  back to `default` so Bash is refused headless, drops empty files into
  `/workspace` that `e` would commit, and widens MCP header blanking to every
  secret-looking name and value.
- **Caveats:** the key stays visible to `env` in Claude's shell, so the
  shared caveat in [Verdict](#verdict) holds for Claude as for pi and
  opencode. The name lists and minified identifiers above are specific to
  2.1.284; a Renovate bump of `HARNESSES.claudeCode.version` should re-run
  this measurement. The host runs used the glibc binary, the container runs
  the musl one; both gave the same header results.
