import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent } from '../agent/agent.js';
import { parseFusionProfile, type FusionContext } from './profile.js';

/*
 * The fusion profile (ADR-0019 section 2): a named Store entity naming the
 * candidate Agents and the synthesizer by name. Parsing is where "fail before
 * anything is built" is kept: a profile that cannot run says so when the
 * Store is read, not after three containers have started.
 */

const where = '.e/fusions/coding/fusion.json';

const minimal = {
  candidates: ['claude', 'codex'],
  synthesizer: 'claude-reviewer',
};

const harness = (name: string) => ({ name, harness: 'claudeCode' });

const context: FusionContext = {
  agents: new Map<string, Agent | Error>([
    ['claude', harness('claude')],
    ['codex', harness('codex')],
    ['pi-local', harness('pi-local')],
    ['claude-reviewer', harness('claude-reviewer')],
    [
      'helper',
      { name: 'helper', transport: 'a2a', url: 'https://agents.example.com' },
    ],
    ['broken', new Error('references unknown harness "gpt"')],
  ]),
};

test('parseFusionProfile: a minimal profile keeps its Agents and defaults the rest', () => {
  const profile = parseFusionProfile(minimal, 'coding', where, context);
  assert.deepEqual(profile, {
    name: 'coding',
    candidates: ['claude', 'codex'],
    synthesizer: 'claude-reviewer',
    strategy: 'parallel-synthesize',
    // min(candidates, 3): two candidates run side by side.
    maxConcurrency: 2,
    minUsable: 1,
  });
});

test('parseFusionProfile: maxConcurrency defaults to at most three', () => {
  const profile = parseFusionProfile(
    { ...minimal, candidates: ['claude', 'codex', 'pi-local', 'claude'] },
    'coding',
    where,
    context
  );
  assert.equal(profile.maxConcurrency, 3);
});

test('parseFusionProfile: a full declaration is taken as it stands', () => {
  const profile = parseFusionProfile(
    {
      name: 'coding',
      candidates: ['claude', 'codex', 'pi-local'],
      synthesizer: 'claude-reviewer',
      strategy: 'parallel-synthesize',
      maxConcurrency: 1,
      minUsable: 2,
      timeouts: { candidatesMs: 60_000, totalMs: 120_000 },
    },
    'coding',
    where,
    context
  );
  assert.equal(profile.maxConcurrency, 1);
  assert.equal(profile.minUsable, 2);
  assert.deepEqual(profile.timeouts, {
    candidatesMs: 60_000,
    totalMs: 120_000,
  });
});

test('parseFusionProfile: the same Agent may be a candidate twice, the same-provider baseline', () => {
  const profile = parseFusionProfile(
    { ...minimal, candidates: ['claude', 'claude'] },
    'coding',
    where,
    context
  );
  assert.deepEqual(profile.candidates, ['claude', 'claude']);
});

test('parseFusionProfile: without a context the Agents are not checked', () => {
  const profile = parseFusionProfile(
    { ...minimal, candidates: ['a', 'b'], synthesizer: 's' },
    'coding',
    where
  );
  assert.deepEqual(profile.candidates, ['a', 'b']);
});

test('parseFusionProfile: what it refuses to accept', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['not an object', [], /must be a JSON object/],
    ['no candidates', { synthesizer: 's' }, /"candidates" is required/],
    [
      'candidates not an array',
      { ...minimal, candidates: 'claude' },
      /"candidates" must be an array/,
    ],
    [
      'one candidate',
      { ...minimal, candidates: ['claude'] },
      /at least two candidates/,
    ],
    [
      'a blank candidate',
      { ...minimal, candidates: ['claude', ''] },
      /candidates\[1\] is not an Agent name/,
    ],
    [
      'a candidate that is not a name',
      { ...minimal, candidates: ['claude', '../codex'] },
      /candidates\[1\] is not an Agent name/,
    ],
    [
      'no synthesizer',
      { candidates: ['claude', 'codex'] },
      /"synthesizer" is required/,
    ],
    [
      'a synthesizer that is not a string',
      { ...minimal, synthesizer: 5 },
      /"synthesizer" is not an Agent name/,
    ],
    [
      'a synthesizer that is not a name',
      { ...minimal, synthesizer: 'a b' },
      /"synthesizer" is not an Agent name/,
    ],
    [
      'an unknown strategy',
      { ...minimal, strategy: 'parallel-select' },
      /unknown strategy "parallel-select"; known: parallel-synthesize/,
    ],
    [
      'maxConcurrency zero',
      { ...minimal, maxConcurrency: 0 },
      /"maxConcurrency" must be a positive integer/,
    ],
    [
      'maxConcurrency fractional',
      { ...minimal, maxConcurrency: 1.5 },
      /"maxConcurrency" must be a positive integer/,
    ],
    [
      'minUsable zero',
      { ...minimal, minUsable: 0 },
      /"minUsable" must be a positive integer/,
    ],
    [
      'minUsable above the candidate count',
      { ...minimal, minUsable: 3 },
      /"minUsable" 3 exceeds the 2 candidates/,
    ],
    [
      'timeouts not an object',
      { ...minimal, timeouts: 5 },
      /"timeouts" must be an object/,
    ],
    [
      'an unknown timeout',
      { ...minimal, timeouts: { perCandidateMs: 5 } },
      /unknown timeout "perCandidateMs"/,
    ],
    [
      'a negative timeout',
      { ...minimal, timeouts: { totalMs: -1 } },
      /"timeouts.totalMs" must be a positive integer/,
    ],
    [
      'a timeout no timer can hold',
      { ...minimal, timeouts: { totalMs: 2 ** 31 } },
      /"timeouts.totalMs" must be at most 2147483647/,
    ],
    [
      'the fan-out not inside the whole',
      { ...minimal, timeouts: { candidatesMs: 100, totalMs: 100 } },
      /"timeouts.candidatesMs" must be less than "timeouts.totalMs"/,
    ],
    [
      'a name that is not the directory',
      { ...minimal, name: 'other' },
      /declares the name "other"; the directory name is the profile's id/,
    ],
    ['an unknown key', { ...minimal, rounds: 2 }, /unknown key "rounds"/],
  ];
  for (const [label, raw, message] of cases) {
    assert.throws(
      () => parseFusionProfile(raw, 'coding', where),
      message,
      label
    );
  }
});

test('parseFusionProfile: errors name the profile and the file', () => {
  assert.throws(
    () => parseFusionProfile({}, 'coding', where),
    /^Error: Invalid fusion profile "coding" at \.e\/fusions\/coding\/fusion\.json: /
  );
});

test('parseFusionProfile: the directory name must be an identifier, since it reaches the PR block', () => {
  assert.throws(
    () => parseFusionProfile(minimal, 'has space', where),
    /the directory name must match/
  );
});

test('parseFusionProfile: a profile carries no provider, harness or credential of its own', () => {
  // Agents by name, never by value: the key belongs in the Agent, where the
  // secrets mechanisms already reach, and a copy here would drift from it.
  for (const key of ['provider', 'harness', 'apiKeyEnv', 'env', 'model']) {
    assert.throws(
      () => parseFusionProfile({ ...minimal, [key]: 'x' }, 'coding', where),
      new RegExp(
        `"${key}" belongs in an Agent; a profile references Agents by name`
      ),
      key
    );
  }
});

test('parseFusionProfile: an Agent the Store cannot resolve is refused, naming the known ones', () => {
  assert.throws(
    () =>
      parseFusionProfile(
        { ...minimal, candidates: ['claude', 'gemini'] },
        'coding',
        where,
        context
      ),
    // Only what a fusion could use is offered: no Remote agent, nothing broken.
    /candidate "gemini" is not an Agent in this Store; known: claude, codex, pi-local, claude-reviewer$/
  );
  assert.throws(
    () =>
      parseFusionProfile(
        { ...minimal, synthesizer: 'judge' },
        'coding',
        where,
        context
      ),
    /synthesizer "judge" is not an Agent in this Store/
  );
});

test('parseFusionProfile: a Remote agent can be neither candidate nor synthesizer', () => {
  // It has no branch and no diff: nothing to hand a synthesizer, and nothing
  // a synthesis could deliver.
  assert.throws(
    () =>
      parseFusionProfile(
        { ...minimal, candidates: ['claude', 'helper'] },
        'coding',
        where,
        context
      ),
    /candidate "helper" is a Remote agent; a fusion needs harness agents, which leave a branch/
  );
  assert.throws(
    () =>
      parseFusionProfile(
        { ...minimal, synthesizer: 'helper' },
        'coding',
        where,
        context
      ),
    /synthesizer "helper" is a Remote agent/
  );
});

test('parseFusionProfile: an Agent that does not resolve is refused with its reason', () => {
  assert.throws(
    () =>
      parseFusionProfile(
        { ...minimal, candidates: ['claude', 'broken'] },
        'coding',
        where,
        context
      ),
    /candidate "broken" does not resolve: references unknown harness "gpt"/
  );
});
