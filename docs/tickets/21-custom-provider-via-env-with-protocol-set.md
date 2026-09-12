# 21 - Custom Provider via env with protocol-set validation (Claude Code)

**Status:** Done (closed 2026-08-08).

**GitHub:** [#10](https://github.com/BelphegorPrime/e/issues/10)

---

## What to build

Let an Agent declare an inline **Provider** (`baseUrl`, `model`, `protocol`, `apiKeyEnv`) per ADR-0006, and deliver it to an **env-based** harness (**Claude Code**) via environment variables (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`). Introduce the per-harness **adapter** seam (env delivery only in this slice). Each Harness declares the _set_ of wire protocols it speaks; `e` rejects an Agent whose `provider.protocol` is not in its harness's set (Claude Code: `{anthropic-messages}`) before running. The API key value stays in `.e/.env` and is injected at runtime — only its env-var name is referenced, never baked.

## Acceptance criteria

- [ ] `agent.json` accepts a `provider` block with the glossary fields.
- [ ] Each Harness declares a `protocols` set; validation rejects mismatches early with a clear message (e.g. Claude + `openai-*` → error).
- [ ] The Claude adapter renders the provider as env vars; a custom Anthropic-compatible endpoint works end-to-end (`e spawn <claude-agent-with-baseUrl> "…"`).
- [ ] API key delivered from `.e/.env` at runtime; never baked; only the name is stored on the agent.
- [ ] Tests for protocol validation and env rendering; `npm test` passes. ADR-0006 respected.

## Blocked by

- #8
