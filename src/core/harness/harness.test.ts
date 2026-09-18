import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESSES,
  harnessCapabilities,
  planMcpDelivery,
  resolveHarness,
  envHarnessSections,
  requiredEnvKeys,
} from './index.js';
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
    '--no-approve',
    '-p',
    'do it',
    '--provider',
    'e',
    '--model',
    'claude-opus-5',
  ]);
});

test('pi buildCommand is plain when no provider/model is configured (default agent)', () => {
  assert.deepEqual(HARNESSES.pi.buildCommand('do it'), [
    'pi',
    '--no-approve',
    '-p',
    'do it',
  ]);
});

test('buildCommand passes the prompt as one argv element, unquoted (the runtime uses no shell)', () => {
  const prompt = 'say "hi" && echo $HOME';
  assert.deepEqual(HARNESSES.pi.buildCommand(prompt).at(-1), prompt);
  assert.deepEqual(HARNESSES.claudeCode.buildCommand(prompt)[2], prompt);
  assert.deepEqual(HARNESSES.codex.buildCommand(prompt).at(-1), prompt);
  assert.deepEqual(HARNESSES.opencode.buildCommand(prompt).at(-1), prompt);
});

test('codex buildCommand bypasses the sandbox, so the run can write /workspace', () => {
  // `codex exec` defaults to a READ-ONLY sandbox: without this flag every write
  // is denied, the denial is fed back to the model, and the process still exits
  // 0 - a run that silently commits nothing.
  assert.deepEqual(HARNESSES.codex.buildCommand('do it'), [
    'codex',
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--ignore-rules',
    'do it',
  ]);
  assert.deepEqual(HARNESSES.codex.buildCommand('do it', 'gpt-5-codex'), [
    'codex',
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--ignore-rules',
    '-m',
    'gpt-5-codex',
    'do it',
  ]);
});

test('opencode is never invoked with --share (that publishes the session)', () => {
  // `--share` publishes the transcript at `opncd.ai/s/<id>` - the whole prompt
  // and every file the agent quoted. Neither invocation may ever carry it
  // (#153); the env half of the same rule is enforced in the spawn plan.
  assert.ok(!HARNESSES.opencode.buildCommand('do it').includes('--share'));
  assert.ok(!HARNESSES.opencode.buildInteractiveCommand().includes('--share'));
});

test('opencode buildCommand auto-approves, so nothing is silently auto-rejected', () => {
  // `opencode run` never prompts: what resolves to `ask` (notably
  // `external_directory` for any path outside cwd) is auto-REJECTED, exit 0.
  assert.deepEqual(HARNESSES.opencode.buildCommand('do it'), [
    'opencode',
    'run',
    '--auto',
    'do it',
  ]);
});

test('claude runs none of the config /workspace supplies (hooks, .mcp.json)', () => {
  // A `-p` session without `--bare` runs the hooks in the project's
  // `.claude/settings.json` and connects the servers in its `.mcp.json` - "even
  // in a folder you've never trusted" (headless docs). `e` mounts an arbitrary
  // repository at /workspace, so cloning one was enough to get code execution
  // in the run container (#153). `--strict-mcp-config` keeps the MCP servers to
  // the ones `e` itself passes with `--mcp-config`.
  assert.deepEqual(HARNESSES.claudeCode.buildCommand('do it'), [
    'claude',
    '-p',
    'do it',
    '--dangerously-skip-permissions',
    '--strict-mcp-config',
    '--settings',
    '{"disableAllHooks":true}',
  ]);
});

// One table, one question per harness, asked of the registry itself: does its
// invocation bypass the approvals the container makes pointless, and does it
// keep out the trust flags that would let `/workspace` supply config? A harness
// added without an answer fails here rather than shipping an opinion nobody
// wrote down.
const POSTURE: Record<
  string,
  {
    bypass: string | null;
    isolatesWorkspace: readonly string[];
    neverTrustsWorkspace: readonly string[];
  }
> = {
  // pi has no approval prompts and no sandbox to bypass, and in non-interactive
  // mode it already ignores `/workspace/.pi/*` and project skills - which is
  // exactly what `--approve`/`-a` would undo.
  pi: {
    bypass: null,
    isolatesWorkspace: ['--no-approve'],
    neverTrustsWorkspace: ['--approve', '-a'],
  },
  // Claude needs no trust flag kept out: `--settings disableAllHooks` and
  // `--strict-mcp-config` already deny the project's hooks and MCP servers.
  claudeCode: {
    bypass: '--dangerously-skip-permissions',
    isolatesWorkspace: ['--strict-mcp-config', '--settings'],
    neverTrustsWorkspace: [],
  },
  // Codex discovers project-layer hooks but runs an untrusted one only under
  // `--dangerously-bypass-hook-trust`.
  codex: {
    bypass: '--dangerously-bypass-approvals-and-sandbox',
    isolatesWorkspace: ['--ignore-rules'],
    neverTrustsWorkspace: ['--dangerously-bypass-hook-trust'],
  },
  // opencode has no lever of either kind at v1.18.31 - see
  // docs/security/attack-surface.md.
  opencode: {
    bypass: '--auto',
    isolatesWorkspace: [],
    neverTrustsWorkspace: [],
  },
};

test('every harness declares its posture: unattended, and never trusting /workspace', () => {
  const everyBypass = Object.values(POSTURE)
    .map(p => p.bypass)
    .filter(flag => flag !== null);
  for (const [name, harness] of Object.entries(HARNESSES)) {
    assert.ok(name in POSTURE, `${name} declares no posture`);
    const { bypass, isolatesWorkspace, neverTrustsWorkspace } = POSTURE[name];
    const oneShot = harness.buildCommand('do it', 'some-model');
    if (bypass) {
      assert.ok(oneShot.includes(bypass), `${name} is missing ${bypass}`);
    } else {
      for (const other of everyBypass) {
        assert.ok(!oneShot.includes(other), `${name} carries a stray ${other}`);
      }
    }
    for (const flag of isolatesWorkspace) {
      assert.ok(oneShot.includes(flag), `${name} is missing ${flag}`);
    }
    const argv = [...oneShot, ...harness.buildInteractiveCommand('some-model')];
    for (const flag of neverTrustsWorkspace) {
      assert.ok(!argv.includes(flag), `${name} must never carry ${flag}`);
    }
  }
});

test('interactive commands start each harness without a one-shot prompt', () => {
  assert.deepEqual(HARNESSES.pi.buildInteractiveCommand(), ['pi']);
  assert.deepEqual(HARNESSES.claudeCode.buildInteractiveCommand(), [
    'claude',
    '--dangerously-skip-permissions',
    '--strict-mcp-config',
    '--settings',
    '{"disableAllHooks":true}',
  ]);
  assert.deepEqual(HARNESSES.codex.buildInteractiveCommand(), ['codex']);
  assert.deepEqual(HARNESSES.opencode.buildInteractiveCommand(), ['opencode']);
});

test('each harness places skills at a path outside /workspace; Claude differs from the shared dir', () => {
  // Claude reads its own skills dir; the others share ~/.agents/skills - all
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
