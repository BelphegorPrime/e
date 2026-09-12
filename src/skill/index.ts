import fs from 'fs';
import path from 'path';
import { skillManifestPath, skillDir, skillsBaseDir } from '../store/paths.js';
import { writeIfAbsent } from '../scaffold.js';
import type { Mount } from '../runtime/index.js';
import { renderSpawnBrotherSkill } from '../broker/skill.js';
import { SPAWN_BROTHER_SKILL } from '../broker/constants.js';

/**
 * The **Skill** context (ADR-0006): a packaged capability - a `SKILL.md` plus
 * optional resource files - an Agent can load, stored under the Store's
 * `skills/<name>/`. Skills reach a harness two ways: an Agent may bake a default
 * set into its image (layer 2), and a Run may add more at spawn time (`--skill`,
 * layer 3). Either way they are delivered by the per-harness placement into the
 * path its CLI reads, **outside `/workspace`**, so they never land in a run's
 * branch. Only harnesses that support skills receive them.
 *
 * This module is the thin `fs` edge over the skill store: it resolves and lists
 * skills and renders the shipped ones. It imports paths *from* `store`, never the
 * reverse. Grounding: `docs/research/harness-cli-facts.md`.
 */

/** The manifest file whose presence marks a directory as a skill. */
export const SKILL_MANIFEST = 'SKILL.md';

/**
 * Resolves a skill name to its source directory on disk, throwing a clear error
 * when the directory or its `SKILL.md` is missing. `root` is the store root.
 */
export function resolveSkill(name: string, root?: string): string {
  const dir = skillDir(name, root);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    const available = listSkillNames(root);
    const list = available.length ? available.join(', ') : '(none)';
    throw new Error(
      `Unknown skill "${name}". Available: ${list}. ` +
        `Add one under .e/skills/<name>/ (with a ${SKILL_MANIFEST}) or run \`e init\`.`
    );
  }
  if (!fs.existsSync(skillManifestPath(name, root))) {
    throw new Error(
      `Skill "${name}" is missing its ${SKILL_MANIFEST} (expected at ${skillManifestPath(name, root)}).`
    );
  }
  return dir;
}

/**
 * Seeds a shipped skill into the store when it is not there yet - a store
 * initialized before the skill existed - and never touches a present one.
 * Names that are not shipped are left to {@link resolveSkill} to report.
 */
export function ensureShippedSkill(name: string, root?: string): void {
  if (!Object.hasOwn(SHIPPED_SKILLS, name)) return;
  const dir = skillDir(name, root);
  if (fs.existsSync(dir)) return;
  for (const [relPath, content] of Object.entries(SHIPPED_SKILLS[name]())) {
    const file = path.join(dir, relPath);
    writeIfAbsent(path.dirname(file), file, content);
  }
}

/** Lists the skill names under the store's `skills/` directory (dirs with any layout). */
export function listSkillNames(root?: string): string[] {
  const dir = skillsBaseDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

/**
 * Parses `--skill` values into a de-duplicated list of skill names, purely.
 * Each value may itself be comma-separated (`--skill a,b`) or the flag repeated
 * (`--skill a --skill b`); blanks are dropped and first-seen order is preserved.
 */
export function parseSkillList(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    for (const part of value.split(',')) {
      const name = part.trim();
      if (name.length > 0) seen.add(name);
    }
  }
  return [...seen];
}

/**
 * The read-only bind mount that places a skill for a run: the host source dir
 * mounted at `<skillsDir>/<name>` inside the container (outside `/workspace`, so
 * it never lands in the run's branch). Pure - the spawn edge collects these.
 */
export function skillMountSpec(
  sourceDir: string,
  skillsDir: string,
  name: string
): Mount {
  return { host: sourceDir, container: `${skillsDir}/${name}`, ro: true };
}

/** The files of a shipped skill, keyed by path relative to the skill's own dir. */
export type SkillFiles = Record<string, string>;

/**
 * A shipped `conventional-commits` skill: guidance the agent can load to write
 * Conventional Commits messages. A minimal, self-contained example of the
 * `SKILL.md` format that `e init` ships so the skill path works out of the box.
 */
export function renderConventionalCommitsSkill(): SkillFiles {
  return {
    'SKILL.md':
      [
        '---',
        'name: conventional-commits',
        'description: Write commit messages in the Conventional Commits format. Use when composing or reviewing a git commit message.',
        '---',
        '',
        '# Conventional Commits',
        '',
        'Write commit subjects as `<type>(<optional scope>): <summary>`.',
        '',
        '- **type**: one of feat, fix, docs, style, refactor, perf, test, build, ci, chore.',
        '- **summary**: imperative mood, lower case, no trailing period, ~50 chars.',
        '- Add a body (blank line, then prose) only when the "why" is not obvious.',
        '- Mark breaking changes with `!` after the type/scope, e.g. `feat!: …`.',
        '',
        'Example: `fix(parser): handle empty input without throwing`.',
      ].join('\n') + '\n',
  };
}

/**
 * A shipped `web-search` skill: guidance the agent can load to use the web
 * search and fetch tools. Shipped to every harness so web research works out
 * of the box.
 */
export function renderWebSearchSkill(): SkillFiles {
  return {
    'SKILL.md':
      [
        '---',
        'name: web-search',
        'description: Web search and URL fetch tools for research, documentation lookup, and current information retrieval. Use when the task needs external knowledge, library docs, API references, or real-world data.',
        '---',
        '',
        '# Web Search',
        '',
        'Search the web and fetch pages for research, docs, and current info.',
        '',
        '## Search tool',
        '',
        'Use `web_search` when you need external information: library docs, API',
        'references, news, specifications, or facts not in the codebase.',
        '',
        '```',
        'web_search(query: ""): returns ranked search results: title, snippet, URL.',
        'Use short focused queries. Apply search operators when helpful.',
        '```',
        '',
        '## Fetch tool',
        '',
        'Use `fetch_content` (pi) / `web_fetch` (other harnesses) to retrieve a',
        'page content when search results give a URL but you need the full text,',
        'code samples, or structured data.',
        '',
        '```',
        'fetch_content(url: ""): returns extracted page content. Prefer over curl.',
        '```',
        '',
        '## How it works',
        '',
        'The `web_search` and `fetch_content` tools are backed by a local Searxng',
        'instance (service `searxng` in the stack) running on the shared egress',
        'network namespace. When a local stack is present, runs share that',
        'namespace, so the instance is always reachable at:',
        '',
        '```',
        'http://localhost:8080',
        '```',
        '',
        "Searxng's JSON API (`/search?format=json&q=<query>`) is a direct fallback",
        "if a harness lacks the wrappers: use `curl`/`wget` or your harness's own",
        'fetch tool against that URL and read the `results` array.',
        '',
        '## When to search',
        '',
        '- Task mentions a library, framework, or API you do not know well.',
        '- You need current behavior, version, or deprecation info.',
        '- You must compare alternatives or find a recommended pattern.',
        '- You need data not present in the repo or local context.',
        '',
        '## When NOT to search',
        '',
        '- The answer is likely in the repo already.',
        '- The question is about the user own code or design preference.',
        '- Search would repeat work the conversation already covered.',
        '',
        '## Process',
        '',
        '1. Search once with a specific query.',
        '2. Open only the most promising URL(s) with the fetch tool.',
        '3. Quote or cite the relevant part in your answer.',
        '4. Stop searching once the answer is supported.',
        '',
        'Do not chain many searches unless the task is explicitly exploratory or the',
        'earlier results clearly miss the target.',
      ].join('\n') + '\n',
  };
}

/** The skills `e init` ships, keyed by name. */
export const SHIPPED_SKILLS: Record<string, () => SkillFiles> = {
  'conventional-commits': renderConventionalCommitsSkill,
  'web-search': renderWebSearchSkill,
  // Requesting sibling runs through the runtime-broker (ADR-0013); selecting
  // it for a run also plans the broker sidecar.
  [SPAWN_BROTHER_SKILL]: renderSpawnBrotherSkill,
};

/**
 * The skill **collections** (git sources understood by the `skills` CLI, e.g.
 * "owner/repo") `e init` bakes into every harness image at build time via
 * `npx skills@latest add <collection> -a <agent> -g -y --copy`. Each harness
 * renders one `RUN` per entry so the collection lands in the skills dir the
 * harness CLI actually reads (outside /workspace).
 */
export const SHIPPED_SKILL_COLLECTIONS: string[] = [
  'mattpocock/skills',
  'JuliusBrussee/caveman',
];
