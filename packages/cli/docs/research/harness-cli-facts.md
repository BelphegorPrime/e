# Harness CLI facts — provider, MCP, and skills configuration

Research grounding the `e` design (ADR-0004/0005/0006) in how each harness's CLI
*actually* takes configuration. Every claim traces to a primary source (official
docs, the CLI's own source/schema, or the published package). Gathered 2026-08-08.

> **Provenance note:** this file was assembled by the maintainer from four
> parallel primary-source investigations (one per harness). Source URLs are
> inline per claim. Where a fact could not be confirmed from a primary source it
> is marked *unverified*.

## Summary

| Harness | custom OpenAI **chat** (`/v1/chat/completions`) | custom OpenAI **responses** (`/v1/responses`) | custom **Anthropic** (`/v1/messages`) | MCP client transports | MCP via CLI flag / inline? | Skills? |
|---|:---:|:---:|:---:|---|---|:---:|
| **Claude Code** | ✗ | ✗ | ✓ (`ANTHROPIC_BASE_URL`) | stdio, streamable HTTP, SSE (deprecated), ws | **Yes** — `--mcp-config '<json>'` (inline or path), `mcp add-json` | ✓ |
| **Codex** | ✗ (`chat` removed) | ✓ (`base_url` + `wire_api="responses"`) | ✗ | stdio, streamable HTTP | No (file / `codex mcp add`; `-c` not endorsed) | ✓ |
| **opencode** | ✓ (`@ai-sdk/openai-compatible`) | ✓ (`@ai-sdk/openai`) | ✓ (`@ai-sdk/anthropic` + `baseURL`) | local stdio, remote HTTP (SSE / streamable) | No flag; file **or** inline env `OPENCODE_CONFIG_CONTENT` | ✓ |
| **pi** | ✓ (`openai-completions`) | ✓ (`openai-responses`) | ✓ (`anthropic-messages`) | **none — MCP not supported** | n/a | ✓ |

**The five load-bearing facts for `e`:**

1. **Protocol is a per-harness capability *set*, and "OpenAI" splits into `chat` vs `responses`.** Claude speaks only Anthropic Messages; Codex speaks only OpenAI *Responses* (`/v1/chat/completions` was removed); opencode and pi speak several. "Point it at any OpenAI-compatible endpoint" is a trap — a Chat-Completions-only endpoint will **not** work with Codex.
2. **MCP wiring is genuinely heterogeneous** — Claude takes it inline via a flag, Codex and opencode need a file (opencode also accepts an inline env), pi has no MCP at all. This is exactly why the per-harness adapter (ADR-0006) with per-harness delivery form is necessary, not optional.
3. **Container-MCP sidecars should speak *streamable HTTP*** — it is the intersection of what the MCP *clients* accept. SSE is deprecated in Claude and absent in Codex.
4. **Skills are cross-harness, not Claude-only** — all four support the `SKILL.md` Agent Skills standard, and `.agents/skills` / `.claude/skills` are emerging shared read paths.
5. **Every harness can relocate its config dir via an env var** (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`), so rendered config can live **outside `/workspace`** — the anti-pollution rule in ADR-0006 is implementable on all four.

---

## Claude Code (`@anthropic-ai/claude-code`, `claude`)

Sources: official Anthropic docs, `code.claude.com/docs/en/{settings,env-vars,cli-reference,mcp,skills,headless,llm-gateway,llm-gateway-protocol}` (docs describe v2.1.x; observed 2026-08-08).

- **Wire protocol: Anthropic Messages API only.** A gateway set via `ANTHROPIC_BASE_URL` must expose `/v1/messages`. The gateway-protocol page lists exactly three accepted formats (Anthropic Messages, Bedrock InvokeModel, Vertex rawPredict) and states Claude Code cannot be routed to non-Claude models through any gateway. **Custom OpenAI-compatible endpoint: not supported. Custom Anthropic-compatible endpoint: yes.**
- **Provider via env:** `ANTHROPIC_API_KEY` (→ `x-api-key`), `ANTHROPIC_AUTH_TOKEN` (→ `Authorization: Bearer`), `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS,FABLE}_MODEL`, `ANTHROPIC_CUSTOM_HEADERS`. No `--base-url` flag; base URL is env/settings only. `--model` and `--settings <file-or-json>` exist. (`env-vars`, `cli-reference`, `llm-gateway-protocol`)
- **Config:** JSON. `~/.claude/settings.json` (user), `.claude/settings.json` (project), `.claude/settings.local.json`, `/etc/claude-code/managed-settings.json`. MCP local/user config in `~/.claude.json`. Config dir relocated by **`CLAUDE_CONFIG_DIR`**. (`settings`, `mcp`)
- **MCP:** `mcpServers` block in `.mcp.json`; **and** CLI: `--mcp-config <file-or-json>` (accepts inline JSON *or* path, repeatable), `--strict-mcp-config`, `claude mcp add`, `claude mcp add-json <name> '<json>'`. Transports: stdio, streamable HTTP (`http`/`streamable-http`), SSE (deprecated), ws. **Remote by URL: yes.** A full server def can be injected inline — **no file required**. (`mcp`)
- **Skills:** `SKILL.md` Agent Skills. Read from `~/.claude/skills/<name>/`, `.claude/skills/<name>/`, nested `<subdir>/.claude/skills/`, plugins. **`--add-dir <path>`** loads `.claude/skills/` from an added dir; `disableBundledSkills`, `skillOverrides` in settings. (`skills`)
- **Headless:** `claude -p "<prompt>" --dangerously-skip-permissions` (= `--permission-mode bypassPermissions`). Also `--permission-mode dontAsk` (recommended for CI), `--output-format json|stream-json`, `--json-schema`, `--bare` (disables auto-discovery; slated to become the `-p` default). (`headless`, `cli-reference`)

## OpenAI Codex CLI (`@openai/codex`, `codex`)

Sources: `github.com/openai/codex` Rust source (`codex-rs/model-provider-info/src/lib.rs`, `codex-rs/core/config.schema.json`, `codex-rs/cli/src/main.rs`) at `main`@`3aae5d8` (2026-08-08) and `learn.chatgpt.com/docs/*` (official, unversioned). Latest release `rust-v0.147.0`. The repo `docs/*.md` are now redirect stubs.

- **Wire protocol: OpenAI *Responses* API only.** The `WireApi` enum has a single variant `Responses` (`/v1/responses`); `wire_api = "chat"` was **removed** and now errors. **Custom OpenAI-compatible endpoint: yes, but it must implement `/v1/responses`** — Chat-Completions-only servers will not work. **Custom Anthropic: no** (only via a translating proxy).
- **Provider via config (`config.toml`):** `model`, `model_provider`, `[model_providers.<id>]` with `base_url`, `env_key`, `wire_api`, `http_headers`, `env_http_headers`; top-level `openai_base_url` repoints the built-in openai provider. Env: `OPENAI_API_KEY`, `OPENAI_BASE_URL`. Flags: `--model`/`-m`, `-c/--config key=value` (TOML dot-notation override; no `--config-file`). (`config-file/config-reference`, `config-advanced`, source)
- **Config:** TOML. `~/.codex/config.toml` (user), `.codex/config.toml` (project, when trusted). Relocated by **`CODEX_HOME`**. `codex exec` accepts `--ignore-user-config`. (`config-reference`)
- **MCP:** `[mcp_servers.<id>]` in `config.toml` — stdio (`command`/`args`/`env`/`env_vars`) and streamable HTTP (`url`, `bearer_token_env_var`, `http_headers`, `auth`, `oauth`). **No SSE.** CLI `codex mcp add|list|login`. Remote by URL: yes (streamable HTTP). `-c` can technically set `mcp_servers.*` but is **not** the endorsed path — **a file (or `codex mcp add`, which writes the file) is intended.** Codex can also *be* an MCP server (`codex mcp-server`). (`extend/mcp`, `config.schema.json`)
- **Skills:** `SKILL.md` Agent Skills. Scanned paths: `$CWD/.agents/skills`, parent dirs, `$REPO_ROOT/.agents/skills`, `$HOME/.agents/skills`, `/etc/codex/skills`. Invocation `/skills` or `$name`. Disable via `[[skills.config]]`. Also `AGENTS.md`, custom prompts under `~/.codex/prompts` (*path unverified this session*). (`build-skills`)
- **Headless:** `codex exec "<prompt>"` (final message → stdout, progress → stderr; `-` reads stdin). Flags: `--sandbox read-only|workspace-write|danger-full-access`, `-a/--ask-for-approval`, `--full-auto`, `--dangerously-bypass-approvals-and-sandbox` (*exact spelling unverified this session*), `--skip-git-repo-check`, `--json`, `--output-schema`, `--ephemeral`. Auth: `CODEX_API_KEY`. (`non-interactive-mode`, source)

## opencode (`opencode-ai`, `opencode`)

Sources: `github.com/sst/opencode` `dev` branch docs `.mdx` (backing `opencode.ai/docs`) and source (`packages/opencode/`, `packages/core/`). Latest release `v1.18.15` (2026-08-07).

- **Foundation:** Vercel AI SDK + Models.dev (75+ providers). **Custom provider** via `provider.<id>`: `npm` (`@ai-sdk/openai-compatible` → `/v1/chat/completions`; `@ai-sdk/openai` → `/v1/responses`; `@ai-sdk/anthropic` → Anthropic Messages), `options.baseURL`, `options.apiKey` (`{env:VAR}` / `{file:~/path}` interpolation), `options.headers`. **Custom OpenAI (chat & responses) and custom Anthropic: all yes.** (`providers.mdx`)
- **Config:** JSON/JSONC. `~/.config/opencode/opencode.json` (global; **respects `XDG_CONFIG_HOME`** per `packages/core/src/global.ts`), project `opencode.json(c)`. Relocated by **`OPENCODE_CONFIG`** (file), **`OPENCODE_CONFIG_DIR`** (dir), **`OPENCODE_CONFIG_CONTENT`** (inline config as env var content). "Config options take precedence over environment variables." (`config.mdx`, source)
- **MCP:** config-file `mcp` block only (no flag). `type:"local"` (stdio: `command[]`, `environment`, `cwd`, `timeout`) or `type:"remote"` (`url`, `headers`, `oauth`, auto DCR/OAuth, tokens in `~/.local/share/opencode/mcp-auth.json`). **Remote by URL: yes.** A full server def can be delivered inline only via `OPENCODE_CONFIG_CONTENT`. CLI `opencode mcp auth|list|logout|debug`. (`mcp-servers.mdx`)
- **Skills:** `SKILL.md` via a native `skill` tool. Read from `.opencode/skills/`, `~/.config/opencode/skills/`, **`.claude/skills/` and `~/.claude/skills/`**, **`.agents/skills/` and `~/.agents/skills/`**. `permission.skill` map; disable with `tools:{skill:false}`. Also `AGENTS.md`/`CLAUDE.md` rules, custom commands/agents. (`skills.mdx`, `rules.mdx`)
- **Headless:** `opencode run "<prompt>"` with `-m provider/model`, `--agent`, `--format json`, **`--auto`** (auto-approve — key for unattended), `--continue`/`--session`. Also `opencode serve` (HTTP API). (`cli.mdx`)

## pi (`@earendil-works/pi-coding-agent`, `pi`)

Sources: published tarball **v0.84.1** (2026-08-07, bundles full `docs/`), npm registry metadata, repo `github.com/earendil-works/pi-mono` (`packages/coding-agent`). Author Mario Zechner; MIT; Node ≥22.19. Well-documented (~35 bundled docs).

- **Provider:** custom endpoints via `~/.pi/agent/models.json` — per-provider `baseUrl`, `api`, `apiKey`, `models[]`. `api` ∈ `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai` (+ a rich `compat` block for vLLM/LM Studio/llama.cpp). **Custom OpenAI (both) and custom Anthropic: yes.** Can also repoint a built-in provider's `baseUrl` without redefining models. Env keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or `~/.pi/agent/auth.json` (`$ENV`/`!shell` interpolation). Flags: `--provider`, `--model`, `--api-key`. Resolution order: `--api-key` → `auth.json` → env → `models.json`. (`docs/providers.md`, `docs/models.md`)
- **Config:** JSON. `~/.pi/agent/settings.json` (global), `.pi/settings.json` (project). Config dir relocated by **`PI_CODING_AGENT_DIR`**. Also `auth.json`, `models.json`, `trust.json`, sessions. (`docs/settings.md`, `docs/environment-variables.md`)
- **MCP:** **not supported** — "intentionally does not include built-in MCP … build or install those workflows as extensions or packages." No config block, flag, or transport. (`docs/usage.md` Design Principles)
- **Skills:** `SKILL.md` Agent Skills. Read from `~/.pi/agent/skills/`, `~/.agents/skills/`, `.pi/skills/`, `.agents/skills/`, packages; **`--skill <path>`** (repeatable, loads even with `--no-skills`); can reuse `~/.claude/skills` / `~/.codex/skills`. Also `AGENTS.md`/`CLAUDE.md`, `SYSTEM.md`. (`docs/skills.md`, `docs/usage.md`)
- **Headless:** `pi -p "<prompt>"` (merges piped stdin). `--mode json` (JSONL event stream), `--mode rpc`. **No skip-permissions flag exists or is needed** — pi has no approval popups and explicitly recommends "run in a container"; only *project trust* exists and is auto-resolved in non-interactive modes (`--approve`/`-a`, `defaultProjectTrust`). Useful: `--no-session`, `--tools`/`-t` allowlist, `--offline`. (`docs/usage.md`, `docs/json.md`, `docs/security.md`)

---

## Design implications for `e`

- **ADR-0006 (protocol):** the `Provider.protocol` field must distinguish `openai-chat`, `openai-responses`, `anthropic-messages` (and `google`), and each Harness declares the **set** it speaks; validation is `provider.protocol ∈ harness.protocols`. Concretely: `claude={anthropic-messages}`, `codex={openai-responses}`, `opencode={openai-chat, openai-responses, anthropic-messages, …}`, `pi={openai-completions, openai-responses, anthropic-messages, google}`.
- **ADR-0006 (delivery):** confirmed heterogeneous — Claude MCP via inline `--mcp-config` flag; Codex & opencode via a rendered config file (opencode also via `OPENCODE_CONFIG_CONTENT`); pi MCP unsupported (capability-gate `--mcp pi`). Provider for Claude is **env**; for Codex/opencode/pi a **config file**. Skills placement path differs per harness (`~/.claude/skills`, `.agents/skills`, `~/.config/opencode/skills`, `~/.pi/agent/skills`) — `.agents/skills` is the widest shared path.
- **ADR-0005 (sidecar transport):** container-MCP sidecars should expose **streamable HTTP**, not SSE.
- **Rendered config lives outside `/workspace`** via each harness's config-dir env var — implementable on all four.
- **Existing `buildCommand`s under-specify unattended runs:** `codex exec <prompt>` defaults to a read-only sandbox with approvals, and `opencode run <prompt>` will prompt on permissions — future agent build commands need the harness's unattended flags (`--dangerously-bypass-approvals-and-sandbox` / appropriate `--sandbox`; `--auto`). Claude already uses `--dangerously-skip-permissions`; pi needs none.
