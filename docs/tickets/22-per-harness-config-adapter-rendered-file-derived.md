# 22 - Per-harness config adapter: rendered file + derived agent image (Codex)

**Status:** Done (closed 2026-08-08).

**GitHub:** [#11](https://github.com/BelphegorPrime/e/issues/11)

---

## What to build

Extend the per-harness config **adapter** (ADR-0006) to render a config **file** and bake it into a **derived agent image** via the Docker builder pattern (ADR-0004) for a file-based harness (**Codex**). From the Agent's declaration, `e` renders a `~/.codex/config.toml` provider block (`base_url`, `env_key`, `wire_api = "responses"`) into a derived Dockerfile (`FROM e-harness-codex`) under `.e/agents/<name>/`, builds the layer-2 image, and runs it. Codex's protocol set is `{openai-responses}` (a Chat-Completions-only endpoint is rejected). Rendered agent files live outside `/workspace`; the API key stays a runtime env value.

## Acceptance criteria

- [ ] The adapter can emit a rendered file artifact (not only env); the Codex adapter renders the `config.toml` provider block.
- [ ] `e` renders + builds a derived agent image `FROM` the harness base and runs it; the base image is reused/cached.
- [ ] Rendered agent files are written under `.e/agents/<name>/`, not overwritten if hand-edited (diff), and never inside `/workspace`.
- [ ] Codex protocol set `{openai-responses}` enforced; a custom Responses endpoint works end-to-end.
- [ ] Tests for file rendering and derived-image build args; `npm test` passes.

## Blocked by

- #10
