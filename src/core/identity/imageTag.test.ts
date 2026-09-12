import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageTag } from './imageTag.js';

test('imageTag namespaces per kind under e-<kind>-', () => {
  assert.equal(imageTag('agent', 'smart-codex'), 'e-agent-smart-codex');
  assert.equal(imageTag('mcp', 'everything'), 'e-mcp-everything');
  assert.equal(imageTag('harness', 'codex'), 'e-harness-codex');
});

test('imageTag lowercases the name (container refs must be lowercase)', () => {
  assert.equal(imageTag('harness', 'claudeCode'), 'e-harness-claudecode');
});
