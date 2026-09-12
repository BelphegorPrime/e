import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSpawnBrotherSkill } from './skill.js';
import { SPAWN_BROTHER_SCRIPT } from './constants.js';

test('the shipped spawn-brother skill has a valid SKILL.md with frontmatter', () => {
  const files = renderSpawnBrotherSkill();
  assert.ok(files['SKILL.md']);
  assert.match(files['SKILL.md'], /^---\n/);
  assert.match(files['SKILL.md'], /^name: spawn-brother$/m);
  assert.match(files['SKILL.md'], /^description: /m);
});

test('the skill points at the role contract, the script, the fallback, and forbids marker files', () => {
  const md = renderSpawnBrotherSkill()['SKILL.md'];
  assert.match(md, /\$E_ROLE/);
  assert.match(md, /\$E_BROKER_URL/);
  assert.match(
    md,
    new RegExp(`node <skill dir>/${SPAWN_BROTHER_SCRIPT} <agent>`)
  );
  assert.match(md, /--status/);
  assert.match(md, /If the broker does not answer/);
  assert.match(md, /marker file/);
  assert.match(md, /Never run git/);
});

test('the skill ships the bundled script, which speaks to $E_BROKER_URL only', () => {
  const script = renderSpawnBrotherSkill()[SPAWN_BROTHER_SCRIPT];
  assert.ok(script.length > 0);
  assert.match(script, /E_BROKER_URL/);
  assert.match(script, /\/spawn/);
  assert.match(script, /\/status/);
  // Dependency-free: only node built-ins may be imported.
  const imports = [...script.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm)]
    .map(m => m[1])
    .filter(spec => !spec.startsWith('node:'));
  assert.deepEqual(imports, []);
});

test('the skill explains the merge-back: the report in the worktree, every merge state, and the --merge signal', () => {
  const md = renderSpawnBrotherSkill()['SKILL.md'];
  assert.match(md, /e-runs\/<id>\/report\.md/);
  for (const state of [
    'merged',
    'up-to-date',
    'conflict',
    'held',
    'skipped',
    'failed',
  ]) {
    assert.match(md, new RegExp(`merge\\.status: ${state}`));
  }
  assert.match(md, new RegExp(`${SPAWN_BROTHER_SCRIPT} --merge <id>`));
  assert.match(md, /never resolves a\s+conflict for you/);
  assert.match(md, /curl -sS -X POST "\$E_BROKER_URL\/merge\/<id>"/);
  const script = renderSpawnBrotherSkill()[SPAWN_BROTHER_SCRIPT];
  assert.match(script, /\/merge\//);
});

test('the skill explains the A2A vocabulary (ADR-0015): taskState, --watch on the event stream, --cancel, remote agents', () => {
  const md = renderSpawnBrotherSkill()['SKILL.md'];
  assert.match(md, /`taskState`/);
  for (const state of [
    'submitted',
    'working',
    'input-required',
    'completed',
    'canceled',
    'rejected',
  ]) {
    assert.match(md, new RegExp(`\`${state}\``));
  }
  assert.match(md, new RegExp(`${SPAWN_BROTHER_SCRIPT} --watch`));
  assert.match(md, new RegExp(`${SPAWN_BROTHER_SCRIPT} --cancel sib-001`));
  assert.match(md, /GET \/status\/events/);
  assert.match(md, /curl -sN "\$E_BROKER_URL\/status\/events"/);
  assert.match(md, /curl -sS -X POST "\$E_BROKER_URL\/cancel\/<id>"/);
  assert.match(md, /"transport": "a2a"/);
  const script = renderSpawnBrotherSkill()[SPAWN_BROTHER_SCRIPT];
  assert.match(script, /\/cancel\//);
  assert.match(script, /\/status\/events/);
});
