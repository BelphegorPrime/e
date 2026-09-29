import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PIN_BUILD_ARGS,
  PIN_LABELS,
  SKILLS_CLI_VERSION,
  checkPin,
  harnessPin,
  pinBuildArgs,
  pinRebuildMessage,
  unpinnedAfterBuildMessage,
  type HarnessPin,
} from './pin.js';
import { HARNESSES } from './index.js';

const pin: HarnessPin = {
  package: '@openai/codex',
  version: '0.159.0',
  skillsCli: '1.7.0',
};

const labelsOf = (p: HarnessPin) => ({
  [PIN_LABELS.package]: p.package,
  [PIN_LABELS.version]: p.version,
  [PIN_LABELS.skillsCli]: p.skillsCli,
});

test('every harness is pinned to an exact version: no range, no tag', () => {
  for (const harness of Object.values(HARNESSES)) {
    assert.match(harness.version, /^\d+\.\d+\.\d+$/, harness.name);
  }
  assert.match(SKILLS_CLI_VERSION, /^\d+\.\d+\.\d+$/);
});

test('harnessPin: the npm package the Dockerfile installs, at the registry version', () => {
  assert.deepEqual(harnessPin(HARNESSES.codex), {
    package: '@openai/codex',
    version: HARNESSES.codex.version,
    skillsCli: SKILLS_CLI_VERSION,
  });
});

test('pinBuildArgs: one build arg per label', () => {
  assert.deepEqual(pinBuildArgs(pin), {
    [PIN_BUILD_ARGS.package]: '@openai/codex',
    [PIN_BUILD_ARGS.version]: '0.159.0',
    [PIN_BUILD_ARGS.skillsCli]: '1.7.0',
  });
});

test('checkPin: match, mismatch on any one of the three, unlabelled', () => {
  assert.deepEqual(checkPin(labelsOf(pin), pin), { status: 'match' });
  for (const key of ['package', 'version', 'skillsCli'] as const) {
    const other = { ...pin, [key]: 'other' };
    assert.deepEqual(checkPin(labelsOf(other), pin), {
      status: 'mismatch',
      found: other,
    });
  }
  // Unrelated labels (the base image's own) are not a pin.
  assert.deepEqual(checkPin({ maintainer: 'x' }, pin), {
    status: 'unlabelled',
  });
  // An empty value is what a build without the args leaves: no pin either.
  assert.deepEqual(
    checkPin(
      {
        [PIN_LABELS.package]: '',
        [PIN_LABELS.version]: '',
        [PIN_LABELS.skillsCli]: '',
      },
      pin
    ),
    { status: 'unlabelled' }
  );
  // A partial set is a mismatch, with the gaps marked.
  assert.deepEqual(checkPin({ [PIN_LABELS.version]: '0.159.0' }, pin), {
    status: 'mismatch',
    found: { package: '?', version: '0.159.0', skillsCli: '?' },
  });
});

test('the messages say what the image was, what the pin is, and the remedy', () => {
  assert.equal(
    pinRebuildMessage(
      'e-harness-codex',
      { status: 'mismatch', found: { ...pin, version: '0.147.0' } },
      pin
    ),
    'Image e-harness-codex was built from @openai/codex@0.147.0 (skills CLI 1.7.0); the pin is @openai/codex@0.159.0 (skills CLI 1.7.0). Rebuilding it.'
  );
  assert.match(
    pinRebuildMessage('e-harness-codex', { status: 'unlabelled' }, pin),
    /carries no version labels/
  );
  const abort = unpinnedAfterBuildMessage(
    'e-harness-codex',
    '/s/.e/harnesses/codex/Dockerfile',
    { status: 'unlabelled' },
    pin
  );
  assert.match(abort, /\/s\/\.e\/harnesses\/codex\/Dockerfile/);
  assert.match(abort, /`e init`/);
  assert.match(abort, /`e init --force`/);
});
