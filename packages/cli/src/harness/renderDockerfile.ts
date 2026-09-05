import Mustache from 'mustache';

/**
 * Parameters for rendering a harness Dockerfile from the shared template.
 * Only the fields that differ between harnesses are required; everything else
 * has a sensible default.
 */
export interface DockerfileParams {
  /** Comment label, e.g. "Claude Code CLI harness." */
  label: string;
  /** npm package installed globally, e.g. "@anthropic-ai/claude-code". */
  npmPackage: string;
  /** Extra flags for `npm install -g`, e.g. ["--ignore-scripts"]. Default: []. */
  npmFlags?: string[];
  /** Base image. Default: "node:lts-alpine". */
  baseImage?: string;
  /** Container workdir. Default: "/workspace". */
  workdir?: string;
  /**
   * Skill collections to install into the image with the `skills` CLI
   * (https://skills.sh), one `RUN npx -y skills@latest add <collection> …`
   * per entry. Each names a git source the CLI understands (e.g.
   * "mattpocock/skills"), installed into the harness's native skills dir
   * (outside /workspace) at build time. Default: [].
   */
  skillCollections?: string[];
  /**
   * This harness's agent name in the skills ecosystem, passed as `-a <agent>`
   * so a collection lands in the skills dir the harness reads (e.g. "pi",
   * "claude-code", "codex", "opencode"). Required when `skillCollections`
   * is non-empty. Default: undefined.
   */
  skillsAgent?: string;
}

/**
 * Shared Dockerfile template. Logic-less (Mustache); defaults are resolved in
 * {@link renderDockerfile} before rendering. Triple-mustache (`{{{ }}}`) is used
 * throughout to disable Mustache's HTML escaping — this is a Dockerfile, and
 * values such as scoped package names and `/workspace` contain `/` that must
 * not be turned into HTML entities.
 */
const TEMPLATE = `FROM {{{baseImage}}}

# {{{label}}}
RUN apk add --no-cache git && npm install -g {{#flags}}{{{.}}} {{/flags}}{{{npmPackage}}}
{{#skillsBlock}}
{{{.}}}
{{/skillsBlock}}
WORKDIR {{{workdir}}}
`;

/**
 * Renders the skill-collection install block. Each collection becomes its own
 * `RUN npx -y skills@latest add <collection> -a <agent> -g -y --copy`, so the
 * CLI places it into the harness agent's global skills dir (verified against
 * the skills CLI's agent map: claude-code → `~/.claude/skills`; the universal
 * codex/opencode → `~/.agents/skills`; pi → `~/.pi/agent/skills`). Git is
 * installed above so the CLI can clone the source at build time.
 */
function renderSkillsBlock(collections: string[], agent: string): string {
  const lines = [
    '# Skills installed via the skills CLI (https://skills.sh), each collection',
    "# placed into the harness agent's global skills dir, outside /workspace.",
  ];
  for (const collection of collections) {
    lines.push(
      `RUN npx -y skills@latest add ${collection} -a ${agent} -g -y --copy`
    );
  }
  return lines.join('\n');
}

/** Renders a Dockerfile for a harness from {@link TEMPLATE}. */
export function renderDockerfile(p: DockerfileParams): string {
  const collections = p.skillCollections ?? [];
  const skillsBlock =
    collections.length > 0 && p.skillsAgent
      ? renderSkillsBlock(collections, p.skillsAgent)
      : undefined;

  return Mustache.render(TEMPLATE, {
    baseImage: p.baseImage ?? 'node:lts-alpine',
    label: p.label,
    flags: p.npmFlags ?? [],
    npmPackage: p.npmPackage,
    skillsBlock,
    workdir: p.workdir ?? '/workspace',
  });
}
