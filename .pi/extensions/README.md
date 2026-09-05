# skill tool extension

Registers a `skill` tool so the agent can load on-demand capability packages itself, without asking the user.

## What it does

- `skill action=list` — lists discoverable skills (name + description) from the standard skill locations
- `skill action=load name=<skill>` — returns the skill's full `SKILL.md` content, prefixed with its path and a note to resolve relative references against the skill directory

## Discovery

Scans, in order (first match on name wins):

1. `<cwd>/.agents/skills`
2. `<cwd>/.pi/skills`
3. `~/.pi/agent/skills` (global)
4. `~/.agents/skills` (global)

## Install

Project-local (this repo): already at `.pi/extensions/skill.ts`.

Global (all projects):

```bash
mkdir -p ~/.pi/agent/extensions
cp .pi/extensions/skill.ts ~/.pi/agent/extensions/
cp .pi/extensions/package.json ~/.pi/agent/extensions/
cd ~/.pi/agent/extensions && npm install
```

Reload with `/reload`.

## Notes

- `import type { ExtensionAPI }` is type-only and erased at runtime; the only runtime dependency is `typebox`, resolved from `node_modules/` next to the extension.
- Skills with missing `name` or `description` frontmatter are skipped.
- YAML block scalars (`description: >`, `description: |`) are supported.