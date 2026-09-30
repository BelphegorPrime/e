import Mustache from 'mustache';
import { PIN_BUILD_ARGS, PIN_LABELS } from './pin.js';

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
  /**
   * Alpine packages the harness needs beyond `git`, installed in the same
   * `apk add` layer, e.g. `["bash"]` for a CLI whose shell tool requires it.
   * Default: [].
   */
  apkPackages?: string[];
  /**
   * Image-level env the harness CLI needs on every run (one-shot, TUI,
   * resume alike), each an `ENV` line: fixed values the harness registry
   * owns, never a secret. Default: {}.
   */
  env?: Readonly<Record<string, string>>;
  /** Extra flags for `npm install -g`, e.g. ["--ignore-scripts"]. Default: []. */
  npmFlags?: string[];
  /**
   * The container user the harness CLI runs as. Default: `'node'` - the
   * non-root user `node:lts-alpine` ships, with a writable home at
   * `/home/node`, so an agent container never runs as root (attack-surface.md
   * Zone 1). Set `'root'` only for a harness whose CLI genuinely needs root at
   * runtime; the harness registry owns that decision.
   */
  runtimeUser?: 'node' | 'root';
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
  /**
   * Optional setup steps to run after installing the global npm package and
   * before installing skills. Each step is a separate `RUN` line. Default: [].
   */
  setupSteps?: string[];
  /**
   * The runtime user's dir the harness's session mount lands inside
   * (ADR-0017), created in the image so the final chown hands it to the
   * runtime user - an engine creates a missing mount parent root-owned, and
   * a harness that writes there then dies on start (EACCES). Carried out as
   * the {@link SESSION_PARENT_LABEL} label, so a spawn can tell an image
   * built from an older Dockerfile, which lacks it. Default: none needed.
   */
  sessionParent?: string;
}

/** The label naming the session mount's parent the image created (ADR-0017). */
export const SESSION_PARENT_LABEL = 'e.harness.session-parent';

/**
 * Shared Dockerfile template. Logic-less (Mustache); defaults are resolved in
 * {@link renderDockerfile} before rendering. Triple-mustache (`{{{ }}}`) is used
 * throughout to disable Mustache's HTML escaping - this is a Dockerfile, and
 * values such as scoped package names and `/workspace` contain `/` that must
 * not be turned into HTML entities.
 */
const TEMPLATE = `FROM {{{baseImage}}}

# {{{label}}}
# The versions are build args, passed by \`e spawn\` from the harness registry
# (ADR-0016 section 10) - pinned there, never here - and carried back out as labels.
ARG {{{argPackage}}}
ARG {{{argVersion}}}
ARG {{{argSkillsCli}}}
{{#homeLine}}{{{.}}}{{/homeLine}}{{#envLines}}{{{.}}}
{{/envLines}}RUN apk add --no-cache git{{#apkPackages}} {{{.}}}{{/apkPackages}} && npm install -g {{#flags}}{{{.}}} {{/flags}}{{{npmPackage}}}@{{{versionRef}}}
{{#setupSteps}}
{{{.}}}
{{/setupSteps}}
{{#skillsBlock}}
{{{.}}}
{{/skillsBlock}}
{{{labelLine}}}
{{#ownerLine}}{{{.}}}{{/ownerLine}}WORKDIR {{{workdir}}}{{#userLine}}{{{.}}}{{/userLine}}
`;

/**
 * Renders the skill-collection install block. Each collection becomes its own
 * `RUN npx -y skills@<pinned CLI> add <collection> -a <agent> -g -y --copy`, so the
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
      `RUN npx -y skills@${argRef(PIN_BUILD_ARGS.skillsCli)} add ${collection} -a ${agent} -g -y --copy`
    );
  }
  return lines.join('\n');
}

/** A build-arg reference as the Dockerfile spells it, `${NAME}`. */
function argRef(name: string): string {
  return `\${${name}}`;
}

/**
 * The `LABEL` that carries the pin back out of the image, each label the value
 * of its build arg, so what the host reads is what the build was given.
 */
function renderLabelLine(sessionParent?: string): string {
  const pairs = (['package', 'version', 'skillsCli'] as const).map(
    key => `${PIN_LABELS[key]}="${argRef(PIN_BUILD_ARGS[key])}"`
  );
  if (sessionParent) pairs.push(`${SESSION_PARENT_LABEL}="${sessionParent}"`);
  return `LABEL ${pairs.join(' ')}`;
}

/**
 * The runtime user's home, used for the non-root default. The `node` user
 * `node:*-alpine` ships has this home pre-created and owned by it, so it is
 * writable without extra layers - the "writable home" half of the non-root
 * baseline.
 */
export const NODE_HOME = '/home/node';

/**
 * Renders a Dockerfile for a harness from {@link TEMPLATE}. The build steps
 * (apk, npm, skills install) run as root; the final `USER` switches to the
 * runtime user (`node` by default, `root` per-harness override). The build-time
 * `ENV HOME` makes the skills CLI's `-g` installs land under the runtime
 * user's home, matching where each harness reads them at runtime - and leaves
 * whatever they create there root-owned, so the home is handed back to the
 * runtime user before the switch (#192: opencode writes its log under
 * `~/.local/share` and dies on start otherwise). The derived agent image does
 * the same for its COPY layers ({@link renderDerivedDockerfile}).
 */
export function renderDockerfile(p: DockerfileParams): string {
  const collections = p.skillCollections ?? [];
  const skillsBlock =
    collections.length > 0 && p.skillsAgent
      ? renderSkillsBlock(collections, p.skillsAgent)
      : undefined;
  const nonRoot = (p.runtimeUser ?? 'node') !== 'root';

  return Mustache.render(TEMPLATE, {
    baseImage: p.baseImage ?? 'node:lts-alpine',
    label: p.label,
    apkPackages: p.apkPackages ?? [],
    flags: p.npmFlags ?? [],
    npmPackage: p.npmPackage,
    setupSteps: [
      ...(p.setupSteps ?? []),
      ...(p.sessionParent ? [`mkdir -p ${p.sessionParent}`] : []),
    ].map(step => `RUN ${step}`),
    skillsBlock,
    workdir: p.workdir ?? '/workspace',
    homeLine: nonRoot ? `ENV HOME=${NODE_HOME}\n` : '',
    envLines: Object.entries(p.env ?? {}).map(([k, v]) => `ENV ${k}=${v}`),
    ownerLine: nonRoot ? `RUN chown -R node:node ${NODE_HOME}\n` : '',
    userLine: nonRoot ? `\nUSER node` : '',
    argPackage: PIN_BUILD_ARGS.package,
    argVersion: PIN_BUILD_ARGS.version,
    argSkillsCli: PIN_BUILD_ARGS.skillsCli,
    versionRef: argRef(PIN_BUILD_ARGS.version),
    labelLine: renderLabelLine(p.sessionParent),
  });
}
