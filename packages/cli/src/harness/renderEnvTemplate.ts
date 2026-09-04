import Mustache from 'mustache';

/**
 * Parameters for rendering the shared `.env` template from the Mustache
 * template below. The file is organised as one section per harness, listing
 * exactly the env vars that harness declares in its `requiredEnv` — env vars
 * are intentionally NOT deduplicated across harnesses.
 */
export interface EnvTemplateParams {
  /** One section is rendered per harness, in listed order. */
  harnesses: EnvHarnessSection[];
  /** Whether to include the explanatory header. Default: true. */
  includeHeader?: boolean;
}

/** A single harness's section in the `.env` template. */
export interface EnvHarnessSection {
  /** Harness name, used as the section header. */
  name: string;
  /** Env vars this harness requires; each becomes a `VAR=` line. */
  env: string[];
}

/**
 * Shared `.env` template. Logic-less (Mustache); defaults are resolved in
 * {@link renderEnvTemplate} before rendering. Triple-mustache (`{{{ }}}`) is
 * used to disable Mustache's HTML escaping so values are emitted verbatim.
 */
const TEMPLATE = `{{#includeHeader}}
# Base environment for all e harness containers.
# \`e spawn\` loads this file into every harness; --env-file and -e override it.
# Fill in the values your harnesses need.

ANTHROPIC_BASE_URL=http://host.docker.internal:20128
ANTHROPIC_API_KEY=local-development

OPENAI_BASE_URL=http://host.docker.internal:20128/v1
OPENAI_API_KEY=local-development

{{/includeHeader}}
{{#harnesses}}
# --- {{{name}}} ---
{{#env}}
{{{.}}}=
{{/env}}

{{/harnesses}}`;

const globalRequiredEnv = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

/** Renders the shared `.env` template from {@link TEMPLATE}. */
export function renderEnvTemplate(p: EnvTemplateParams): string {
  const harnesses = p.harnesses.map(h => ({
    name: h.name,
    env: h.env.filter(e => !globalRequiredEnv.includes(e)),
  }));

  return Mustache.render(TEMPLATE, {
    includeHeader: p.includeHeader ?? true,
    harnesses: harnesses.filter(h => h.env.length > 0),
  });
}
