import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Provider } from '../harness/adapter';
import {
  modelsUrl,
  parseModelIds,
  resolveProviderModel,
  type ModelsLister,
} from './resolve';

const anthropic: Provider = {
  baseUrl: 'https://gateway.example.com',
  model: 'auto',
  protocol: 'anthropic-messages',
  apiKeyEnv: 'MY_KEY',
};

const codex: Provider = {
  baseUrl: 'https://gateway.example.com/v1',
  model: 'auto',
  protocol: 'openai-responses',
  apiKeyEnv: 'MY_KEY',
};

/** A lister that returns a fixed set, or throws to simulate an unreachable endpoint. */
function fakeLister(ids: string[] | Error): ModelsLister {
  return {
    list: async () => {
      if (ids instanceof Error) throw ids;
      return ids;
    },
  };
}

test('modelsUrl: appends /v1/models when the base has no version segment', () => {
  assert.equal(
    modelsUrl('https://gateway.example.com'),
    'https://gateway.example.com/v1/models'
  );
});

test('modelsUrl: appends /models when the base already ends in /v1', () => {
  assert.equal(
    modelsUrl('https://gateway.example.com/v1'),
    'https://gateway.example.com/v1/models'
  );
});

test('modelsUrl: tolerates a trailing slash', () => {
  assert.equal(
    modelsUrl('https://gateway.example.com/'),
    'https://gateway.example.com/v1/models'
  );
});

test('parseModelIds: extracts data[].id, ignoring malformed entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-store-'));
  const ids = parseModelIds(
    {
      data: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }, { notId: 'x' }, 'nope'],
    },
    { root }
  );
  assert.deepEqual(ids, ['gpt-5', 'gpt-5-mini']);
});

test('parseModelIds: an unexpected shape yields no ids rather than throwing', () => {
  assert.deepEqual(parseModelIds({}, { root: undefined }), []);
  assert.deepEqual(parseModelIds(null, { root: undefined }), []);
});

test('resolveProviderModel: a concrete model is returned as-is, never listed', async () => {
  let listed = false;
  const lister: ModelsLister = {
    list: async () => {
      listed = true;
      return [];
    },
  };
  const resolved = await resolveProviderModel(
    { ...codex, model: 'gpt-5-codex' },
    'smart',
    lister
  );
  assert.deepEqual(resolved, { model: 'gpt-5-codex', fromAuto: false });
  assert.equal(listed, false);
});

test('resolveProviderModel: auto resolves against the listed models for the tier', async () => {
  const resolved = await resolveProviderModel(
    anthropic,
    'smart',
    fakeLister(['anthropic.claude-sonnet-5', 'anthropic.claude-opus-5'])
  );
  assert.deepEqual(resolved, {
    model: 'anthropic.claude-opus-5',
    fromAuto: true,
  });
});

test('resolveProviderModel: an unreachable endpoint falls back to defaultModel', async () => {
  const resolved = await resolveProviderModel(
    { ...anthropic, defaultModel: 'anthropic.claude-sonnet-5' },
    'smart',
    fakeLister(new Error('ECONNREFUSED'))
  );
  assert.deepEqual(resolved, {
    model: 'anthropic.claude-sonnet-5',
    fromAuto: true,
  });
});

test('resolveProviderModel: an unreachable endpoint with no defaultModel is a clear error', async () => {
  await assert.rejects(
    resolveProviderModel(
      anthropic,
      'smart',
      fakeLister(new Error('ECONNREFUSED'))
    ),
    /unreachable|defaultModel/i
  );
});
