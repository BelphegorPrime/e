import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROKER_ALIAS,
  BROKER_PORT,
  BROKER_URL_ENV,
  ROLE_ENV,
  brokerUrl,
  isRoleContractEntry,
  parseRunRole,
  roleEnv,
  runRoleInstructions,
} from './runRole.js';

// The contract names are what agents read (`$E_ROLE`, `$E_BROKER_URL`) and
// what AGENTS.md documents, so they are pinned here.
test('the contract variable names are E_ROLE and E_BROKER_URL', () => {
  assert.equal(ROLE_ENV, 'E_ROLE');
  assert.equal(BROKER_URL_ENV, 'E_BROKER_URL');
});

test('parseRunRole: unset or blank means parent', () => {
  assert.equal(parseRunRole(undefined, 'E_SPAWN_ROLE'), 'parent');
  assert.equal(parseRunRole('', 'E_SPAWN_ROLE'), 'parent');
  assert.equal(parseRunRole('   ', 'E_SPAWN_ROLE'), 'parent');
});

test('parseRunRole: accepts the two roles, trimmed', () => {
  assert.equal(parseRunRole('parent', 'E_SPAWN_ROLE'), 'parent');
  assert.equal(parseRunRole('child', 'E_SPAWN_ROLE'), 'child');
  assert.equal(parseRunRole(' child ', 'E_SPAWN_ROLE'), 'child');
});

test('parseRunRole: rejects anything else, naming the source variable', () => {
  assert.throws(
    () => parseRunRole('root', 'E_SPAWN_ROLE'),
    /Unknown run role "root" in E_SPAWN_ROLE.*parent.*child/
  );
});

test('brokerUrl: private per-run network reaches the broker by alias', () => {
  assert.equal(brokerUrl(false), `http://${BROKER_ALIAS}:${BROKER_PORT}`);
  assert.equal(brokerUrl(false), 'http://runtime-broker:20130');
});

test('brokerUrl: shared egress namespace reaches the broker on loopback', () => {
  // Mirrors the MCP endpoint rule: in the `e-egress` netns every sidecar sits
  // on the same loopback as the agent.
  assert.equal(brokerUrl(true), `http://localhost:${BROKER_PORT}`);
});

test('brokerUrl: honours an explicit port', () => {
  assert.equal(brokerUrl(false, 4242), 'http://runtime-broker:4242');
});

test('roleEnv: renders the two -e entries, role first', () => {
  assert.deepEqual(roleEnv('child', 'http://runtime-broker:20130'), [
    'E_ROLE=child',
    'E_BROKER_URL=http://runtime-broker:20130',
  ]);
  assert.deepEqual(roleEnv('parent', 'http://localhost:20130'), [
    'E_ROLE=parent',
    'E_BROKER_URL=http://localhost:20130',
  ]);
});

test('isRoleContractEntry: matches the two contract keys only, by key', () => {
  assert.equal(isRoleContractEntry('E_ROLE=child'), true);
  assert.equal(isRoleContractEntry('E_BROKER_URL=http://x:1'), true);
  assert.equal(isRoleContractEntry('E_ROLE_X=1'), false);
  assert.equal(isRoleContractEntry('FOO=E_ROLE=child'), false);
  assert.equal(isRoleContractEntry('E_SPAWN_ROLE=child'), false);
});

test('runRoleInstructions: names the role, both variables, the fallback, and forbids marker files', () => {
  const text = runRoleInstructions('child');
  assert.match(text, /"child"/);
  assert.match(text, /\$E_ROLE/);
  assert.match(text, /\$E_BROKER_URL/);
  // Honest about the broker: named, not promised to answer.
  assert.match(text, /if nothing answers there/);
  assert.match(text, /files in the worktree/);
  assert.match(text, /marker files/i);
  assert.match(runRoleInstructions('parent'), /"parent"/);
});
