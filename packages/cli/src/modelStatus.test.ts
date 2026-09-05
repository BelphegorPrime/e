import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBytes,
  formatDuration,
  isModelReady,
  describeModels,
  waitForModelsReady,
  type ModelsResponse,
} from './modelStatus';

test('formatBytes: renders human-readable sizes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(195_963_406), '186.9 MB');
  assert.equal(formatBytes(3 * 1024 ** 3), '3.0 GB');
});

test('formatDuration: renders minutes and seconds', () => {
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(150_000), '2m 30s');
  assert.equal(formatDuration(-1), 'unknown');
});

test('isModelReady: loaded and sleeping count as ready, everything else does not', () => {
  assert.equal(isModelReady({ value: 'loaded' }), true);
  assert.equal(isModelReady({ value: 'sleeping' }), true);
  assert.equal(isModelReady({ value: 'downloading' }), false);
  assert.equal(isModelReady(undefined), false);
});

test('describeModels: reports downloading progress with an ETA once a second sample arrives', () => {
  const models = ['org/model-a'];
  const history = new Map();
  const downloading = (done: number): ModelsResponse => ({
    data: [
      {
        id: 'org/model-a',
        status: {
          value: 'downloading',
          progress: { 'https://example/file.gguf': { done, total: 1000 } },
        },
      },
    ],
  });

  const first = describeModels(downloading(100), models, history, 0);
  assert.equal(first.ready, false);
  assert.match(first.lines[0], /downloading 10%/);
  assert.match(first.lines[0], /estimating\.\.\./);

  const second = describeModels(downloading(600), models, history, 1000);
  assert.equal(second.ready, false);
  assert.match(second.lines[0], /downloading 60%/);
  assert.match(second.lines[0], /remaining/);
});

test('describeModels: reports ready when at least one requested model is ready', () => {
  const result = describeModels(
    {
      data: [
        { id: 'org/model-a', status: { value: 'loaded' } },
        { id: 'org/model-b', status: { value: 'loading' } },
      ],
    },
    ['org/model-a', 'org/model-b'],
    new Map(),
    0
  );

  assert.equal(result.ready, true);
  assert.match(result.lines[0], /ready \(loaded\)/);
  assert.match(result.lines[1], /loading into memory/);
});

test('describeModels: loading and loaded states', () => {
  const models = ['org/model-a'];
  const history = new Map();

  const loading = describeModels(
    { data: [{ id: 'org/model-a', status: { value: 'loading' } }] },
    models,
    history,
    0
  );
  assert.equal(loading.ready, false);
  assert.match(loading.lines[0], /loading into memory/);

  const loaded = describeModels(
    { data: [{ id: 'org/model-a', status: { value: 'loaded' } }] },
    models,
    history,
    0
  );
  assert.equal(loaded.ready, true);
  assert.match(loaded.lines[0], /ready \(loaded\)/);
});

test('describeModels: a missing/unloaded entry keeps waiting instead of failing', () => {
  const result = describeModels({ data: [] }, ['org/model-a'], new Map(), 0);
  assert.equal(result.ready, false);
  assert.match(result.lines[0], /waiting to start/);
});

test('describeModels: a failed model is reported and excluded from readiness', () => {
  const result = describeModels(
    {
      data: [
        { id: 'org/model-a', status: { value: 'unloaded', failed: true } },
      ],
    },
    ['org/model-a'],
    new Map(),
    0
  );
  assert.deepEqual(result.failed, ['org/model-a']);
  assert.equal(result.ready, false);
});

test('waitForModelsReady: polls until ready, printing progress and a final ready line', async () => {
  const responses: ModelsResponse[] = [
    {
      data: [
        {
          id: 'org/model-a',
          status: {
            value: 'downloading',
            progress: { url: { done: 500, total: 1000 } },
          },
        },
      ],
    },
    { data: [{ id: 'org/model-a', status: { value: 'loading' } }] },
    { data: [{ id: 'org/model-a', status: { value: 'loaded' } }] },
  ];
  let call = 0;
  const lines: string[] = [];
  let clock = 0;

  await waitForModelsReady({
    baseUrl: 'http://fake',
    models: ['org/model-a'],
    fetchImpl: (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => responses[Math.min(call++, responses.length - 1)],
      }) as unknown as Response) as typeof fetch,
    sleep: async () => {
      clock += 1000;
    },
    now: () => clock,
    onLine: line => lines.push(line),
  });

  assert.match(lines.join('\n'), /downloading 50%/);
  assert.match(lines.join('\n'), /loading into memory/);
  assert.match(lines.join('\n'), /At least one model is ready\./);
});

test('waitForModelsReady: rejects when a model fails to load', async () => {
  await assert.rejects(
    waitForModelsReady({
      baseUrl: 'http://fake',
      models: ['org/model-a'],
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 'org/model-a',
                status: { value: 'unloaded', failed: true },
              },
            ],
          }),
        }) as unknown as Response) as typeof fetch,
      sleep: async () => {},
      onLine: () => {},
    }),
    /failed to load/
  );
});

test('waitForModelsReady: throws on a non-OK HTTP response', async () => {
  await assert.rejects(
    waitForModelsReady({
      baseUrl: 'http://fake',
      models: ['org/model-a'],
      fetchImpl: (async () =>
        ({ ok: false, status: 500 }) as unknown as Response) as typeof fetch,
      sleep: async () => {},
      onLine: () => {},
    }),
    /HTTP 500/
  );
});
