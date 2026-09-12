import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  branchPrefix,
  brokerContainerFor,
  forParts,
  fromBranch,
  maxRunCounter,
  namePattern,
  sidecarContainerFor,
} from './runName.js';

test('branchPrefix is e/<agent>/<slug>, without the counter', () => {
  assert.equal(
    branchPrefix('claudeCode', 'fix-parser'),
    'e/claudeCode/fix-parser'
  );
});

test('fromBranch parses local and remote-tracking run short names', () => {
  assert.deepEqual(fromBranch('e/claudeCode/fix-typos-2'), {
    branch: 'e/claudeCode/fix-typos-2',
    agent: 'claudeCode',
    slug: 'fix-typos',
    counter: 2,
    name: 'e-claudeCode-fix-typos-2',
    network: 'e-claudeCode-fix-typos-2-net',
  });
  assert.deepEqual(fromBranch('origin/e/cheap-codex/tidy-tests-1'), {
    branch: 'e/cheap-codex/tidy-tests-1',
    agent: 'cheap-codex',
    slug: 'tidy-tests',
    counter: 1,
    name: 'e-cheap-codex-tidy-tests-1',
    network: 'e-cheap-codex-tidy-tests-1-net',
  });
});

test('fromBranch keeps digits inside the slug', () => {
  const run = fromBranch('e/demo/fix-issue-404-7');
  assert.equal(run?.slug, 'fix-issue-404');
  assert.equal(run?.counter, 7);
});

test('fromBranch rejects non-run branches', () => {
  assert.equal(fromBranch('e/README'), undefined);
  assert.equal(fromBranch('main'), undefined);
  assert.equal(fromBranch('e/agent'), undefined);
  assert.equal(fromBranch('e/agent/slug'), undefined);
  // A remote segment of `e` collides with the run namespace itself.
  assert.equal(fromBranch('e/e/agent/slug-1'), undefined);
});

test('fromBranch is plain data: it survives a JSON round-trip', () => {
  const run = fromBranch('e/demo/fix-1');
  assert.deepEqual(JSON.parse(JSON.stringify(run)), run);
});

test('forParts round-trips through fromBranch', () => {
  const run = forParts('claudeCode', 'fix-parser', 2);
  assert.equal(run.branch, 'e/claudeCode/fix-parser-2');
  assert.equal(run.name, 'e-claudeCode-fix-parser-2');
  assert.deepEqual(fromBranch(run.branch), run);
});

test('forParts derives the private network', () => {
  assert.equal(forParts('demo', 'fix', 1).network, 'e-demo-fix-1-net');
});

test('forParts refuses parts that would read back as a different run', () => {
  // `e/a/b/fix-1` parses as agent "a", slug "b/fix" - not what the caller asked for.
  assert.throws(() => forParts('a/b', 'fix', 1), /Not a run identity/);
});

test('sidecarContainerFor and brokerContainerFor namespace per run', () => {
  const run = forParts('demo', 'fix', 1);
  assert.equal(
    sidecarContainerFor(run, 'everything'),
    'e-demo-fix-1-mcp-everything'
  );
  assert.equal(brokerContainerFor(run), 'e-demo-fix-1-broker');
});

test('namePattern anchors the run name and escapes regex characters', () => {
  const pattern = new RegExp(namePattern('smart.pi', 'fix-login'));
  assert.ok(pattern.test('/e-smart.pi-fix-login-1'));
  assert.ok(pattern.test('e-smart.pi-fix-login-12'));
  assert.ok(!pattern.test('/e-smartXpi-fix-login-1'));
  assert.ok(!pattern.test('/e-smart.pi-fix-login-extra-1'));
  assert.ok(!pattern.test('/e-smart.pi-fix-login-1-mcp-everything'));
});

test('namePattern matches the name of any run of that agent and slug', () => {
  const pattern = new RegExp(namePattern('demo', 'fix'));
  for (const counter of [1, 2, 42]) {
    assert.ok(pattern.test(forParts('demo', 'fix', counter).name));
  }
});

const prefix = 'e/claudeCode/fix-parser';

test('maxRunCounter returns 0 when no branch matches', () => {
  assert.equal(maxRunCounter([], prefix), 0);
  assert.equal(maxRunCounter(['e/claudeCode/other-1'], prefix), 0);
});

test('maxRunCounter takes the max across matching local branches', () => {
  assert.equal(
    maxRunCounter([`${prefix}-1`, `${prefix}-3`, `${prefix}-2`], prefix),
    3
  );
});

test('maxRunCounter considers remote-tracking refs', () => {
  assert.equal(maxRunCounter([`${prefix}-1`, `origin/${prefix}-4`], prefix), 4);
});

test('maxRunCounter ignores a longer slug that shares this prefix', () => {
  // e/claudeCode/fix-parser-fast-2 belongs to slug "fix-parser-fast", not "fix-parser".
  assert.equal(maxRunCounter([`${prefix}-fast-2`, `${prefix}-1`], prefix), 1);
});

test('maxRunCounter ignores non-numeric suffixes', () => {
  assert.equal(maxRunCounter([`${prefix}-wip`, `${prefix}-2`], prefix), 2);
});

test('maxRunCounter ignores refs nested deeper than one remote segment', () => {
  // `for-each-ref --format=%(refname:short)` yields at most `<remote>/<branch>`.
  assert.equal(maxRunCounter([`refs/heads/${prefix}-9`], prefix), 0);
});
