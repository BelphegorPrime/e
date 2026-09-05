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
RUN npm install -g {{#flags}}{{{.}}} {{/flags}}{{{npmPackage}}}

WORKDIR {{{workdir}}}
`;

/** Renders a Dockerfile for a harness from {@link TEMPLATE}. */
export function renderDockerfile(p: DockerfileParams): string {
  return Mustache.render(TEMPLATE, {
    baseImage: p.baseImage ?? 'node:lts-alpine',
    label: p.label,
    flags: p.npmFlags ?? [],
    npmPackage: p.npmPackage,
    workdir: p.workdir ?? '/workspace',
  });
}
