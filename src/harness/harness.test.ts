import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESSES, harnessCapabilities, planMcpDelivery, resolveHarness, envHarnessSections, requiredEnvKeys } from './index.js';
import type { McpEndpoint } from '../mcp/index.js';

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

test('harnessCapabilities.mcp declares each harness form: flag (Claude), file (Codex/pi), none (opencode)', () => {
  assert.equal(harnessCapabilities(HARNESSES.claudeCode).mcp, 'flag');
  assert.equal(harnessCapabilities(HARNESSES.codex).mcp, 'file');
  // pi gets an MCP client from the pi-mcp-adapter extension (installed in its
  // image), so its file adapter delivers a mcp.json overlay.
  assert.equal(harnessCapabilities(HARNESSES.pi).mcp, 'file');
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
  assert.equal(delivery.overlay.mountTo, '/home/node/.codex/config.toml');
});

test('planMcpDelivery wires pi as a mcp.json overlay next to the baked models.json', () => {
  const endpoints: McpEndpoint[] = [
    { name: 'everything', url: 'http://everything:3001/mcp' },
  ];
  const delivery = planMcpDelivery(HARNESSES.pi, endpoints, '');
  if (delivery.form !== 'file')
    return assert.fail(`expected file, got ${delivery.form}`);
  // pi-mcp-adapter reads standard MCP JSON: a `mcpServers` map of url entries.
  const parsed = JSON.parse(delivery.overlay.file.content);
  assert.deepEqual(parsed.mcpServers.everything, {
    url: 'http://everything:3001/mcp',
  });
  assert.equal(delivery.overlay.file.fileName, 'mcp.json');
  assert.equal(delivery.overlay.mountTo, '/home/node/.pi/agent/mcp.json');
});

test('planMcpDelivery reports no delivery for a harness without MCP wiring (opencode)', () => {
  assert.deepEqual(planMcpDelivery(HARNESSES.opencode, [], ''), {
    form: 'none',
  });
});

test('pi buildCommand selects the e provider and resolved model when one is delivered', () => {
  assert.deepEqual(HARNESSES.pi.buildCommand('do it', 'claude-opus-5'), [
    'pi',
    '-p',
    '"do it"',
    '--provider',
    'e',
    '--model',
    'claude-opus-5',
  ]);
});

test('pi buildCommand is plain when no provider/model is configured (default agent)', () => {
  assert.deepEqual(HARNESSES.pi.buildCommand('do it'), ['pi', '-p', '"do it"']);
});

test('interactive commands start each harness without a one-shot prompt', () => {
  assert.deepEqual(HARNESSES.pi.buildInteractiveCommand(), ['pi']);
  assert.deepEqual(HARNESSES.claudeCode.buildInteractiveCommand(), [
    'claude',
    '--dangerously-skip-permissions',
  ]);
  assert.deepEqual(HARNESSES.codex.buildInteractiveCommand(), ['codex']);
  assert.deepEqual(HARNESSES.opencode.buildInteractiveCommand(), ['opencode']);
});

test('each harness places skills at a path outside /workspace; Claude differs from the shared dir', () => {
  // Claude reads its own skills dir; the others share ~/.agents/skills — all
  // under the non-root runtime user's home (/home/node).
  assert.equal(HARNESSES.claudeCode.skillsDir, '/home/node/.claude/skills');
  assert.equal(HARNESSES.codex.skillsDir, '/home/node/.agents/skills');
  assert.equal(HARNESSES.opencode.skillsDir, '/home/node/.agents/skills');
  assert.equal(HARNESSES.pi.skillsDir, '/home/node/.agents/skills');
  for (const h of Object.values(HARNESSES)) {
    assert.ok(h.skillsDir && !h.skillsDir.startsWith('/workspace'));
  }
});

test('every shipped harness runs the container as the non-root node user', () => {
  // The registry owns the runtime-user decision: nothing ships a root override
  // today, so the template default (non-root `node`) applies to all four. The
  // override seam is exercised in renderDockerfile.test.ts.
  for (const h of Object.values(HARNESSES)) {
    assert.equal(h.dockerfile.runtimeUser ?? 'node', 'node');
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

test('resolveHarness returns the registered harness by name', () => {
  for (const name of Object.keys(HARNESSES)) {
    assert.equal(resolveHarness(name), HARNESSES[name]);
  }
});

test('resolveHarness throws with the valid names for an unknown harness', () => {
  assert.throws(
    () => resolveHarness('no-such-harness'),
    (error: Error) => {
      assert.match(error.message, /Unknown harness "no-such-harness"/);
      for (const name of Object.keys(HARNESSES)) {
        assert.ok(error.message.includes(name), `lists ${name}`);
      }
      return true;
    }
  );
});

test('envHarnessSections emits one section per harness with its requiredEnv verbatim', () => {
  const sections = envHarnessSections();
  assert.equal(sections.length, Object.keys(HARNESSES).length);
  for (const section of sections) {
    const harness = HARNESSES[section.name];
    assert.ok(harness, `section names a harness: ${section.name}`);
    assert.deepEqual(section.env, harness.requiredEnv);
  }
});

test('requiredEnvKeys is the deduped union in first-seen order, optional base URLs first', () => {
  const keys = requiredEnvKeys();
  // Optional base-URL keys lead the list regardless of harness order.
  assert.equal(keys[0], 'OPENAI_BASE_URL');
  assert.equal(keys[1], 'ANTHROPIC_BASE_URL');
  // Every harness's requiredEnv is present, deduped.
  const expected = new Set<string>();
  for (const h of Object.values(HARNESSES)) {
    for (const key of h.requiredEnv) expected.add(key);
  }
  assert.equal(keys.length, expected.size + 2);
  assert.equal(new Set(keys).size, keys.length, 'no duplicates');
  for (const key of expected) assert.ok(keys.includes(key), key);
});
