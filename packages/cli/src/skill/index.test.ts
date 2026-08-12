import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveSkill,
  listSkillNames,
  parseSkillList,
  skillMountSpec,
  renderConventionalCommitsSkill,
  SHIPPED_SKILLS,
  SKILL_MANIFEST,
} from './index';
import { skillDir, skillManifestPath } from '../store';

/** Makes a temp store root with the given skills (each a dir + SKILL.md). */
function makeRoot(skills: string[] = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-skill-test-'));
  for (const name of skills) {
    fs.mkdirSync(skillDir(name, root), { recursive: true });
    fs.writeFileSync(skillManifestPath(name, root), '# skill\n');
  }
  return root;
}

test('resolveSkill returns the source dir for a skill with a SKILL.md', () => {
  const root = makeRoot(['helper']);
  assert.equal(resolveSkill('helper', root), skillDir('helper', root));
});

test('resolveSkill errors listing available skills when the name is unknown', () => {
  const root = makeRoot(['helper']);
  assert.throws(
    () => resolveSkill('missing', root),
    /Unknown skill "missing"[\s\S]*helper/
  );
});

test('resolveSkill errors when the directory exists but has no SKILL.md', () => {
  const root = makeRoot();
  fs.mkdirSync(skillDir('empty', root), { recursive: true });
  assert.throws(() => resolveSkill('empty', root), new RegExp(SKILL_MANIFEST));
});

test('listSkillNames lists directories under skills/, empty when none', () => {
  assert.deepEqual(listSkillNames(makeRoot()), []);
  const root = makeRoot(['a', 'b']);
  assert.deepEqual(listSkillNames(root).sort(), ['a', 'b']);
});

test('the shipped conventional-commits skill has a valid SKILL.md with frontmatter', () => {
  const files = renderConventionalCommitsSkill();
  assert.ok(files['SKILL.md']);
  assert.match(files['SKILL.md'], /^---\n/);
  assert.match(files['SKILL.md'], /^name: conventional-commits$/m);
  assert.match(files['SKILL.md'], /^description: /m);
});

test('e init ships at least one skill', () => {
  assert.ok(Object.keys(SHIPPED_SKILLS).length >= 1);
  assert.ok('conventional-commits' in SHIPPED_SKILLS);
});

test('parseSkillList flattens comma-separated and repeated values, trims, de-dupes, keeps order', () => {
  assert.deepEqual(parseSkillList(['a,b', ' c ', 'a']), ['a', 'b', 'c']);
  assert.deepEqual(parseSkillList([]), []);
  assert.deepEqual(parseSkillList(['', ' , ']), []);
});

test('skillMountSpec places a skill read-only at <skillsDir>/<name>, outside /workspace', () => {
  const spec = skillMountSpec(
    '/host/.e/skills/helper',
    '/root/.claude/skills',
    'helper'
  );
  assert.deepEqual(spec, {
    host: '/host/.e/skills/helper',
    container: '/root/.claude/skills/helper',
    ro: true,
  });
  // The container-side target is outside /workspace, so it never enters the branch.
  assert.ok(!spec.container.startsWith('/workspace'));
});
