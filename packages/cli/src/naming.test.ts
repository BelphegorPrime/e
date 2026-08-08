import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageTag, runName, runBranchPrefix } from './naming';

test('imageTag namespaces per kind under e-<kind>-', () => {
  assert.equal(imageTag('agent', 'smart-codex'), 'e-agent-smart-codex');
  assert.equal(imageTag('mcp', 'everything'), 'e-mcp-everything');
  assert.equal(imageTag('harness', 'codex'), 'e-harness-codex');
});

test('imageTag lowercases the name (container refs must be lowercase)', () => {
  assert.equal(imageTag('harness', 'claudeCode'), 'e-harness-claudecode');
});

test('runBranchPrefix is e/<agent>/<slug>, without the counter', () => {
  assert.equal(runBranchPrefix('claudeCode', 'fix-parser'), 'e/claudeCode/fix-parser');
});

test('runName derives the branch and the dashed run identity', () => {
  const run = runName('claudeCode', 'fix-parser', 2);
  assert.equal(run.branch, 'e/claudeCode/fix-parser-2');
  assert.equal(run.name, 'e-claudeCode-fix-parser-2');
});

test('runName derives the private network and per-sidecar container name', () => {
  const run = runName('demo', 'fix', 1);
  assert.equal(run.network, 'e-demo-fix-1-net');
  assert.equal(run.sidecarContainer('everything'), 'e-demo-fix-1-mcp-everything');
});
