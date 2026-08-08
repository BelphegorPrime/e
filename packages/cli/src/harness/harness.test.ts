import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESSES, mcpDeliveryForm, fileAdapterFor, skillsSupported } from './index';
import type { McpEndpoint } from '../mcp/index';

const claude = HARNESSES.claudeCode;

test('claude renderMcpArgs emits inline --mcp-config with an http server per endpoint', () => {
  const endpoints: McpEndpoint[] = [
    { name: 'everything', url: 'http://everything:3001/mcp' },
  ];
  const args = claude.renderMcpArgs!(endpoints);
  assert.equal(args[0], '--mcp-config');
  assert.deepEqual(JSON.parse(args[1]), {
    mcpServers: {
      everything: { type: 'http', url: 'http://everything:3001/mcp' },
    },
  });
});

test('claude renderMcpArgs wires multiple endpoints under one mcpServers object', () => {
  const args = claude.renderMcpArgs!([
    { name: 'everything', url: 'http://everything:3001/mcp' },
    { name: 'filesystem', url: 'http://filesystem:8000/mcp' },
  ]);
  const parsed = JSON.parse(args[1]);
  assert.deepEqual(Object.keys(parsed.mcpServers), ['everything', 'filesystem']);
});

test('claude renderMcpArgs returns no args when there are no endpoints', () => {
  assert.deepEqual(claude.renderMcpArgs!([]), []);
});

test('claude renderMcpArgs passes remote auth headers through verbatim (for ${VAR} expansion)', () => {
  const args = claude.renderMcpArgs!([
    {
      name: 'hosted',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer ${TOKEN}' },
    },
  ]);
  assert.deepEqual(JSON.parse(args[1]), {
    mcpServers: {
      hosted: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer ${TOKEN}' },
      },
    },
  });
});

test('claude renderMcpArgs omits headers when an endpoint has none', () => {
  const args = claude.renderMcpArgs!([
    { name: 'everything', url: 'http://everything:3001/mcp' },
  ]);
  assert.equal('headers' in JSON.parse(args[1]).mcpServers.everything, false);
});

test('only Claude wires MCP inline today; the others have no renderMcpArgs', () => {
  assert.equal(typeof HARNESSES.claudeCode.renderMcpArgs, 'function');
  assert.equal(HARNESSES.codex.renderMcpArgs, undefined);
  assert.equal(HARNESSES.opencode.renderMcpArgs, undefined);
  assert.equal(HARNESSES.pi.renderMcpArgs, undefined);
});

test('mcpDeliveryForm declares each harness capability: flag (Claude), file (Codex), none (pi)', () => {
  assert.equal(mcpDeliveryForm(HARNESSES.claudeCode), 'flag');
  assert.equal(mcpDeliveryForm(HARNESSES.codex), 'file');
  // pi has no MCP client, so --mcp is gated off.
  assert.equal(mcpDeliveryForm(HARNESSES.pi), 'none');
  // opencode has no MCP delivery wired yet, so it is gated off too.
  assert.equal(mcpDeliveryForm(HARNESSES.opencode), 'none');
});

test('fileAdapterFor narrows to the file adapter only for a file harness', () => {
  assert.equal(fileAdapterFor(HARNESSES.codex)?.kind, 'file');
  assert.equal(fileAdapterFor(HARNESSES.claudeCode), undefined);
  assert.equal(fileAdapterFor(HARNESSES.pi), undefined);
});

test('each harness places skills at a path outside /workspace; Claude differs from the shared dir', () => {
  // Claude reads its own skills dir; the others share ~/.agents/skills.
  assert.equal(HARNESSES.claudeCode.skillsDir, '/root/.claude/skills');
  assert.equal(HARNESSES.codex.skillsDir, '/root/.agents/skills');
  assert.equal(HARNESSES.opencode.skillsDir, '/root/.agents/skills');
  assert.equal(HARNESSES.pi.skillsDir, '/root/.agents/skills');
  for (const h of Object.values(HARNESSES)) {
    assert.ok(h.skillsDir && !h.skillsDir.startsWith('/workspace'));
  }
});

test('skillsSupported reflects a declared skillsDir (all real harnesses support skills)', () => {
  for (const h of Object.values(HARNESSES)) {
    assert.equal(skillsSupported(h), true);
  }
  // A harness with no skillsDir is gated off (defensive; no such harness ships).
  assert.equal(skillsSupported({ ...HARNESSES.pi, skillsDir: undefined }), false);
});
