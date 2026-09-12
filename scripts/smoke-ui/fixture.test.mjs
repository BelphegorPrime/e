import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENTS,
  BLACKLIST,
  EGRESS_URL,
  FixtureGit,
  RUN_REFS,
  SQUASHED_LOGS,
  TERMINAL_OPTIONS,
  fixtureDeps,
  fixtureFetch,
  fixtureTerminal,
  requireBuild,
  startFixture,
} from './fixture.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

test('FixtureGit: run refs under e/ with pushed twins, a log per branch, writes refused', () => {
  const git = new FixtureGit();
  const refs = git.listRunRefs('e');
  assert.equal(refs, RUN_REFS);
  assert.ok(refs.every(ref => /^(origin\/)?e\//.test(ref.name)));
  assert.ok(refs.some(ref => ref.name === 'e/pi/fix-login-redirect-1'));
  assert.ok(refs.some(ref => ref.name === 'origin/e/pi/fix-login-redirect-1'));
  assert.equal(git.runLog('e/pi/run-7').length, 2);
  assert.deepEqual(git.runLog('e/pi/nope-9'), []);
  assert.equal(git.branchExists('e/pi/run-7'), true);
  assert.equal(git.isRepo(), true);
  assert.throws(() => git.push('e/pi/run-7'), /read-only/);
});

test('fixtureFetch: the egress API routes from memory; the blacklist mutates; anything else is 404', async () => {
  const fetchImpl = fixtureFetch();
  const squashed = await fetchImpl(`${EGRESS_URL}/logs/squashed`);
  assert.equal(squashed.status, 200);
  assert.deepEqual(await squashed.json(), SQUASHED_LOGS);

  const before = await (
    await fetchImpl(`${EGRESS_URL}/blacklist/domains`)
  ).json();
  assert.deepEqual(before, { domains: BLACKLIST });

  const added = await fetchImpl(`${EGRESS_URL}/blacklist/domains`, {
    method: 'POST',
    body: JSON.stringify({ domain: 'evil.example' }),
  });
  assert.equal(added.status, 200);
  const after = await (
    await fetchImpl(`${EGRESS_URL}/blacklist/domains`)
  ).json();
  assert.deepEqual(after.domains, [...BLACKLIST, 'evil.example']);

  const removed = await fetchImpl(
    `${EGRESS_URL}/blacklist/domains/evil.example`,
    { method: 'DELETE' }
  );
  assert.equal(removed.status, 200);
  assert.deepEqual(
    (await (await fetchImpl(`${EGRESS_URL}/blacklist/domains`)).json()).domains,
    BLACKLIST
  );

  const bad = await fetchImpl(`${EGRESS_URL}/blacklist/domains`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(bad.status, 400);
  assert.equal((await fetchImpl(`${EGRESS_URL}/nope`)).status, 404);
  // A fresh fetch has a fresh blacklist: the module constant is never mutated.
  assert.deepEqual(BLACKLIST, ['tracker.example.net', 'ads.example.org']);
});

test('fixtureTerminal: an engine, the options, sessions that start exited and can be removed', () => {
  const terminal = fixtureTerminal();
  assert.equal(terminal.engineAvailable, true);
  assert.equal(terminal.options(), TERMINAL_OPTIONS);
  assert.deepEqual(terminal.list(), []);
  const session = terminal.start({ agent: 'pi', slug: 'fix-it' });
  assert.equal(session.phase, 'exited');
  assert.equal(terminal.get(session.id), session);
  assert.equal(terminal.list().length, 1);
  terminal.remove(session.id);
  assert.deepEqual(terminal.list(), []);
});

test('fixtureDeps: the ServeAppDeps shape with a fresh worktrees dir', t => {
  const deps = fixtureDeps();
  t.after(() => fs.rmSync(deps.worktreesDir, { recursive: true, force: true }));
  assert.deepEqual(deps.listAgents(), AGENTS);
  assert.equal(deps.egressApiUrl, EGRESS_URL);
  assert.equal(deps.omniRouteEmbedPort, null);
  assert.ok(fs.existsSync(deps.worktreesDir));
  assert.ok(deps.worktreesDir.startsWith(os.tmpdir()));
});

test('requireBuild: names the missing build step', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-ui-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => requireBuild(root),
    /dist\/ui\/index.html \(npm run build:ui\).*dist\/serve\/serve.js \(npm run build:ts\).*npm run build:dev/
  );
  fs.mkdirSync(path.join(root, 'dist', 'ui'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'dist', 'ui', 'index.html'),
    '<html></html>'
  );
  assert.throws(
    () => requireBuild(root),
    /Missing: dist\/serve\/serve.js \(npm run build:ts\)/
  );
});

test('startFixture: serves the built UI with the fakes behind /api (needs npm run build:dev)', async t => {
  try {
    requireBuild(repoRoot);
  } catch {
    t.skip('dist/ui or dist/serve not built');
    return;
  }
  const fixture = await startFixture(repoRoot);
  t.after(() => fixture.close());
  const info = await (await fetch(`${fixture.baseUrl}/api/info`)).json();
  assert.equal(info.terminal, true);
  assert.equal(info.omniRouteEmbedPort, null);
  const runs = await (await fetch(`${fixture.baseUrl}/api/runs`)).json();
  assert.ok(Array.isArray(runs.runs) && runs.runs.length > 0);
  const agents = await (await fetch(`${fixture.baseUrl}/api/agents`)).json();
  assert.equal(agents.agents[0].name, 'pi');
  const squashed = await (
    await fetch(`${fixture.baseUrl}/api/egress/logs/squashed`)
  ).json();
  assert.equal(squashed.length, SQUASHED_LOGS.length);
  const options = await (
    await fetch(`${fixture.baseUrl}/api/terminal/options`)
  ).json();
  assert.deepEqual(options, TERMINAL_OPTIONS);
  const page = await fetch(`${fixture.baseUrl}/runs`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="?root"?[ >]/);
});
