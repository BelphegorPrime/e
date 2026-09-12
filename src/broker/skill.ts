/**
 * The shipped **spawn-brother** skill (ADR-0013): the SKILL.md that teaches an
 * agent inside a run to request sibling runs through its runtime-broker, plus
 * the script that does the HTTP call (the bundled, type-checked `./cli.ts`,
 * run with the harness image's own `node`). Selecting this skill for a run is
 * what plans the broker sidecar.
 */

import { SPAWN_BROTHER_CLI_BUNDLE } from './bundle.generated.js';
import { SPAWN_BROTHER_SCRIPT, SPAWN_BROTHER_SKILL } from './constants.js';
import type { SkillFiles } from '../skill/index.js';

const SKILL_MD =
  [
    '---',
    `name: ${SPAWN_BROTHER_SKILL}`,
    'description: Request a sibling run (a "brother" agent) from inside an e run through the runtime-broker, and check its status. Use when a task splits into independent parts another agent should take on in parallel.',
    '---',
    '',
    '# Spawn a brother (sibling run)',
    '',
    'You are inside an e run. The host set `$E_ROLE` (`parent` | `child`) and',
    '`$E_BROKER_URL` (the runtime-broker endpoint) in your environment. Roles are',
    'env, never files: do not create or look for parent/child marker files.',
    '',
    `This skill directory holds \`${SPAWN_BROTHER_SCRIPT}\`; run it with \`node\` (every`,
    'harness image has one). It lives where your harness loads skills from, e.g.',
    `\`~/.agents/skills/${SPAWN_BROTHER_SKILL}/${SPAWN_BROTHER_SCRIPT}\` (pi, codex, opencode) or`,
    `\`~/.claude/skills/${SPAWN_BROTHER_SKILL}/${SPAWN_BROTHER_SCRIPT}\` (Claude Code).`,
    '',
    '## Request a sibling',
    '',
    '```bash',
    `node <skill dir>/${SPAWN_BROTHER_SCRIPT} <agent> "<the whole task: goal, scope, acceptance criteria, files, constraints>"`,
    '```',
    '',
    'Prints the accepted request as JSON: `{"id":"sib-001","status":"requested","statusPath":"/status/sib-001"}`.',
    'A refusal prints the JSON error and exits 1: `429` means the fan-out cap is',
    'full - retry after one of your siblings finishes; `403` means this run may',
    'not spawn (it is a sibling itself).',
    'The call is non-blocking: it queues the request for the host, which starts the',
    'sibling in the background while you keep working. Several siblings may run at',
    'once (the host caps them, default 3).',
    'Depth is two: you may request siblings; a sibling may request siblings; nobody',
    'gets grandchildren.',
    '',
    '## Check on siblings',
    '',
    '```bash',
    `node <skill dir>/${SPAWN_BROTHER_SCRIPT} --status            # every sibling of this run`,
    `node <skill dir>/${SPAWN_BROTHER_SCRIPT} --status sib-001    # one`,
    '```',
    '',
    'States: `requested` (spooled for the host) -> `starting` -> `running` -> `done`',
    "(carries the sibling's branch: its work is there, and lands in your worktree once",
    'the host merges it back) or',
    '`failed` (carries the error). A request that stays `requested` is not being',
    'picked up: use the fallback below.',
    '',
    '## Without the script',
    '',
    '```bash',
    'curl -sS -X POST "$E_BROKER_URL/spawn" -H "content-type: application/json" -d \'{"agent":"<agent>","prompt":"<task>"}\'',
    'curl -sS "$E_BROKER_URL/status"',
    '```',
    '',
    '## If the broker does not answer',
    '',
    'The script exits 3 (connection refused / no `$E_BROKER_URL`): sibling spawning',
    'is unavailable in this run. Record the task and its acceptance criteria as a',
    'file in `/workspace`, exit 0, and let the parent (or the host) spawn the',
    'follow-up run.',
    '',
    '## Rules',
    '',
    '- Put everything the brother needs into the prompt; it has no access to your',
    '  conversation, only to a checkpoint of your worktree.',
    '- Never run git yourself; the host owns git for you and your siblings.',
    '- The role is `$E_ROLE`; never a marker file in the worktree.',
  ].join('\n') + '\n';

/** The files of the shipped `spawn-brother` skill. */
export function renderSpawnBrotherSkill(): SkillFiles {
  return {
    'SKILL.md': SKILL_MD,
    [SPAWN_BROTHER_SCRIPT]: SPAWN_BROTHER_CLI_BUNDLE,
  };
}
