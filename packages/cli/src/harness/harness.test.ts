import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESSES, harnessCapabilities, planMcpDelivery } from './index';
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
  assert.deepEqual(Object.keys(parsed.mcpServers), [
    'everything',
    'filesystem',
  ]);
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

test('harnessCapabilities.mcp declares each harness form: flag (Claude), file (Codex), none (pi/opencode)', () => {
  assert.equal(harnessCapabilities(HARNESSES.claudeCode).mcp, 'flag');
  assert.equal(harnessCapabilities(HARNESSES.codex).mcp, 'file');
  // pi has no MCP client, so --mcp is gated off.
  assert.equal(harnessCapabilities(HARNESSES.pi).mcp, 'none');
  // opencode has no MCP delivery wired yet, so it is gated off too.
  assert.equal(harnessCapabilities(HARNESSES.opencode).mcp, 'none');
});

test('harnessCapabilities.provider reflects the adapter kind (env Claude, file Codex/pi, none opencode)', () => {
  assert.equal(harnessCapabilities(HARNESSES.claudeCode).provider, 'env');
  assert.equal(harnessCapabilities(HARNESSES.codex).provider, 'file');
  // pi delivers its provider via a baked models.json, so it is a file harness too.
  assert.equal(harnessCapabilities(HARNESSES.pi).provider, 'file');
  // opencode ships no config adapter yet.
  assert.equal(harnessCapabilities(HARNESSES.opencode).provider, 'none');
});

test('planMcpDelivery wires Claude inline as a flag (--mcp-config args)', () => {
  const endpoints: McpEndpoint[] = [
    { name: 'everything', url: 'http://everything:3001/mcp' },
  ];
  const delivery = planMcpDelivery(HARNESSES.claudeCode, endpoints, '');
  if (delivery.form !== 'flag')
    return assert.fail(`expected flag, got ${delivery.form}`);
  assert.equal(delivery.args[0], '--mcp-config');
  assert.deepEqual(JSON.parse(delivery.args[1]).mcpServers.everything, {
    type: 'http',
    url: 'http://everything:3001/mcp',
  });
});

test('planMcpDelivery wires Codex as a file overlay merged onto the baked base config', () => {
  const endpoints: McpEndpoint[] = [
    { name: 'everything', url: 'http://everything:3001/mcp' },
  ];
  const delivery = planMcpDelivery(HARNESSES.codex, endpoints, 'model = "x"\n');
  if (delivery.form !== 'file')
    return assert.fail(`expected file, got ${delivery.form}`);
  // The overlay merges the MCP block onto the base config and mounts at Codex's dir.
  assert.match(delivery.overlay.file.content, /model = "x"/);
  assert.match(delivery.overlay.file.content, /\[mcp_servers\.everything\]/);
  assert.equal(delivery.overlay.mountTo, '/root/.codex/config.toml');
});

test('planMcpDelivery reports no delivery for a harness without an MCP client (pi/opencode)', () => {
  assert.deepEqual(planMcpDelivery(HARNESSES.pi, [], ''), { form: 'none' });
  assert.deepEqual(planMcpDelivery(HARNESSES.opencode, [], ''), {
    form: 'none',
  });
});

test('pi buildCommand selects the e provider and resolved model when one is delivered', () => {
  assert.deepEqual(HARNESSES.pi.buildCommand('do it', 'claude-opus-5'), [
    'pi',
    '-p',
    'do it',
    '--provider',
    'e',
    '--model',
    'claude-opus-5',
  ]);
});

test('pi buildCommand is plain when no provider/model is configured (default agent)', () => {
  assert.deepEqual(HARNESSES.pi.buildCommand('do it'), ['pi', '-p', 'do it']);
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

test('harnessCapabilities.skills is the declared skillsDir (all real harnesses support skills)', () => {
  for (const h of Object.values(HARNESSES)) {
    assert.equal(harnessCapabilities(h).skills, h.skillsDir);
    assert.ok(harnessCapabilities(h).skills !== undefined);
  }
  // A harness with no skillsDir is gated off (defensive; no such harness ships).
  assert.equal(
    harnessCapabilities({ ...HARNESSES.pi, skillsDir: undefined }).skills,
    undefined
  );
});
