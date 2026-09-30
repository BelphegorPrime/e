import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  findFusionProfile,
  loadFusionProfile,
  loadFusionProfiles,
} from './load.js';
import { storeFusionContext } from './context.js';

/*
 * Loading fusion profiles off disk (ADR-0019). A broken profile is an invalid
 * entry for a listing, never a dead Store; `e fuse`, which is about to spend
 * money on it, gets a throw with the reason instead.
 */

function withStore(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-fusions-'));
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeFile(root: string, rel: string, body: string): void {
  const file = path.join(root, '.e', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function writeAgent(root: string, name: string, body: object): void {
  writeFile(root, `agents/${name}/agent.json`, JSON.stringify(body));
}

const valid = JSON.stringify({
  candidates: ['claudeCode', 'codex'],
  synthesizer: 'claudeCode',
});

test('loadFusionProfiles: a Store with no fusions directory loads nothing', () => {
  withStore(root => {
    assert.deepEqual(loadFusionProfiles(root), []);
  });
});

test('loadFusionProfiles: the directory name is the id, and a broken one is an entry with its reason', () => {
  withStore(root => {
    writeFile(root, 'fusions/coding/fusion.json', valid);
    writeFile(root, 'fusions/broken/fusion.json', '{ not json');
    writeFile(root, 'fusions/empty/README.md', 'nothing here');
    const loaded = loadFusionProfiles(root).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    assert.deepEqual(
      loaded.map(entry => entry.name),
      ['broken', 'coding', 'empty']
    );
    assert.equal(loaded[1].profile?.synthesizer, 'claudeCode');
    assert.equal(loaded[1].error, undefined);
    // A JSON error names the profile and the file, like any other refusal.
    assert.match(
      loaded[0].error ?? '',
      /^Invalid fusion profile "broken" at .*fusion\.json: .*JSON/
    );
    assert.equal(loaded[0].profile, undefined);
    assert.equal(loaded[2].error, 'no fusion.json in empty/');
  });
});

test('findFusionProfile: returns the profile, checked against the Store it was found in', () => {
  withStore(root => {
    writeAgent(root, 'claude-reviewer', {
      name: 'claude-reviewer',
      harness: 'claudeCode',
    });
    writeFile(
      root,
      'fusions/coding/fusion.json',
      JSON.stringify({
        candidates: ['claudeCode', 'codex', 'pi'],
        synthesizer: 'claude-reviewer',
      })
    );
    const { profile, agents } = findFusionProfile('coding', root);
    assert.deepEqual(profile.candidates, ['claudeCode', 'codex', 'pi']);
    assert.equal(profile.synthesizer, 'claude-reviewer');
    // The Agents handed on are the ones that were checked, resolved as a
    // spawn resolves them: a Store agent from its file, a bare harness as
    // its default agent.
    assert.deepEqual(agents.get('claude-reviewer'), {
      name: 'claude-reviewer',
      harness: 'claudeCode',
    });
    assert.deepEqual(agents.get('pi'), { name: 'pi', harness: 'pi' });
    assert.deepEqual([...agents.keys()].sort(), [
      'claude-reviewer',
      'claudeCode',
      'codex',
      'pi',
    ]);
  });
});

test('findFusionProfile: an Agent the Store does not have fails before anything is built', () => {
  withStore(root => {
    writeFile(
      root,
      'fusions/coding/fusion.json',
      JSON.stringify({
        candidates: ['claudeCode', 'gemini'],
        synthesizer: 'claudeCode',
      })
    );
    assert.throws(
      () => findFusionProfile('coding', root),
      /candidate "gemini" is not an Agent in this Store/
    );
  });
});

test('findFusionProfile: a Remote agent in the Store is refused by name', () => {
  withStore(root => {
    writeAgent(root, 'helper', {
      name: 'helper',
      transport: 'a2a',
      url: 'https://agents.example.com/a2a',
    });
    writeFile(
      root,
      'fusions/coding/fusion.json',
      JSON.stringify({
        candidates: ['claudeCode', 'helper'],
        synthesizer: 'claudeCode',
      })
    );
    assert.throws(
      () => findFusionProfile('coding', root),
      /candidate "helper" is a Remote agent/
    );
  });
});

test('findFusionProfile: an unknown profile names the ones there are', () => {
  withStore(root => {
    writeFile(root, 'fusions/coding/fusion.json', valid);
    writeFile(root, 'fusions/review/fusion.json', valid);
    assert.throws(
      () => findFusionProfile('nope', root),
      /Unknown fusion profile "nope"\. Available: coding, review\./
    );
  });
  withStore(root => {
    assert.throws(
      () => findFusionProfile('nope', root),
      /Unknown fusion profile "nope"\. Available: \(none\)\./
    );
  });
});

test('findFusionProfile: a name that is not an identifier never reaches the filesystem', () => {
  withStore(root => {
    assert.throws(
      () => findFusionProfile('../agents/x', root),
      /not a fusion profile name/
    );
  });
});

test('findFusionProfile: an Agent that would not spawn is refused now, not after the base is pinned', () => {
  withStore(root => {
    // The directory name is the identity: a file declaring another name
    // passes no listing of declared names and fails every spawn.
    writeAgent(root, 'reviewer', { name: 'other', harness: 'claudeCode' });
    writeAgent(root, 'ghost', { name: 'ghost', harness: 'gpt' });
    writeFile(
      root,
      'fusions/a/fusion.json',
      JSON.stringify({
        candidates: ['claudeCode', 'reviewer'],
        synthesizer: 'claudeCode',
      })
    );
    writeFile(
      root,
      'fusions/b/fusion.json',
      JSON.stringify({
        candidates: ['claudeCode', 'codex'],
        synthesizer: 'ghost',
      })
    );
    assert.throws(
      () => findFusionProfile('a', root),
      /candidate "reviewer" does not resolve: .*the directory name is the agent's identity/
    );
    assert.throws(
      () => findFusionProfile('b', root),
      /synthesizer "ghost" does not resolve: .*unknown harness "gpt"/
    );
  });
});

test('findFusionProfile: a broken Agent the profile does not name blocks nothing', () => {
  withStore(root => {
    writeFile(root, 'agents/junk/agent.json', '{ not json');
    writeFile(root, 'fusions/coding/fusion.json', valid);
    assert.equal(
      findFusionProfile('coding', root).profile.synthesizer,
      'claudeCode'
    );
  });
});

test('loadFusionProfile: a name that is not an identifier never becomes a path', () => {
  withStore(root => {
    writeFile(root, 'agents/x/fusion.json', valid);
    const loaded = loadFusionProfile('../agents/x', root);
    assert.equal(loaded.profile, undefined);
    assert.match(loaded.error ?? '', /is not a fusion profile name/);
  });
});

test('storeFusionContext: every Store agent and bare harness, resolved or with its reason', () => {
  withStore(root => {
    writeAgent(root, 'claude-reviewer', {
      name: 'claude-reviewer',
      harness: 'claudeCode',
    });
    writeAgent(root, 'helper', {
      name: 'helper',
      transport: 'a2a',
      url: 'https://agents.example.com/a2a',
    });
    writeAgent(root, 'ghost', { name: 'ghost', harness: 'gpt' });
    // A Store agent named like a harness shadows it, as in a spawn.
    writeAgent(root, 'codex', { name: 'codex', harness: 'pi' });
    const agents = storeFusionContext(root).agents!;
    assert.deepEqual(agents.get('claude-reviewer'), {
      name: 'claude-reviewer',
      harness: 'claudeCode',
    });
    assert.equal(
      (agents.get('helper') as { transport?: string }).transport,
      'a2a'
    );
    assert.ok(agents.get('ghost') instanceof Error);
    assert.deepEqual(agents.get('codex'), { name: 'codex', harness: 'pi' });
    assert.deepEqual(agents.get('opencode'), {
      name: 'opencode',
      harness: 'opencode',
    });
  });
});
