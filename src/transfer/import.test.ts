import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { importConfiguration } from './import.js';
import { RecordingRunner } from './runnerStub.js';
import { OMNIROUTE_VOLUME } from '../constants.js';
import {
  envFilePath,
  configFilePath,
  dockerComposePath,
  bootstrapScriptPath,
} from '../store/paths.js';

/** Writes `files` under `root` and zips them to `out` (flat archive). */
function zipFiles(
  root: string,
  out: string,
  files: Record<string, string>
): string {
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content);
  }
  const zip = new AdmZip();
  for (const name of Object.keys(files)) {
    zip.addLocalFile(path.join(root, name));
  }
  zip.writeZip(out);
  return out;
}

test('importConfiguration: a missing zip file is a hard error naming the file', async () => {
  await assert.rejects(
    () => importConfiguration({ file: '/no/such/import.zip' }),
    /Import file not found/
  );
});

test('importConfiguration: existing config without --force refuses to overwrite', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-import-'));
  const zipPath = path.join(root, 'import.zip');
  zipFiles(root, zipPath, { '.env': 'SECRET=value\n' });
  fs.mkdirSync(path.join(root, '.e'), { recursive: true });
  fs.writeFileSync(envFilePath(root), 'EXISTING=1\n');
  try {
    await assert.rejects(
      () => importConfiguration({ file: zipPath, root }),
      /Configuration already exists/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importConfiguration: restores every archive entry under the .e store', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-import-'));
  const zipPath = path.join(root, 'import.zip');
  zipFiles(root, zipPath, {
    '.env': 'SECRET=value\n',
    'config.json': '{"defaultHarness":"claude"}\n',
    'compose.yaml': 'services: {}\n',
    'bootstrap.sh': '#!/bin/sh\n',
  });
  try {
    await importConfiguration({ file: zipPath, root });

    assert.equal(fs.readFileSync(envFilePath(root), 'utf8'), 'SECRET=value\n');
    assert.equal(
      fs.readFileSync(configFilePath(root), 'utf8'),
      '{"defaultHarness":"claude"}\n'
    );
    assert.equal(
      fs.readFileSync(dockerComposePath(root), 'utf8'),
      'services: {}\n'
    );
    assert.equal(
      fs.readFileSync(bootstrapScriptPath(root), 'utf8'),
      '#!/bin/sh\n'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importConfiguration: a missing archive entry is skipped, not fatal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-import-'));
  const zipPath = path.join(root, 'import.zip');
  zipFiles(root, zipPath, { '.env': 'SECRET=value\n' });
  try {
    await importConfiguration({ file: zipPath, root });
    assert.equal(fs.readFileSync(envFilePath(root), 'utf8'), 'SECRET=value\n');
    assert.ok(!fs.existsSync(configFilePath(root)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importConfiguration: --force deletes existing files before restoring', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-import-'));
  const zipPath = path.join(root, 'import.zip');
  fs.mkdirSync(path.join(root, '.e'), { recursive: true });
  fs.writeFileSync(envFilePath(root), 'STALE=1\n');
  fs.writeFileSync(configFilePath(root), '{"stale":true}\n');
  zipFiles(root, zipPath, {
    '.env': 'FRESH=1\n',
    'config.json': '{"fresh":true}\n',
  });
  try {
    await importConfiguration({ file: zipPath, root, force: true });
    assert.equal(fs.readFileSync(envFilePath(root), 'utf8'), 'FRESH=1\n');
    assert.equal(
      fs.readFileSync(configFilePath(root), 'utf8'),
      '{"fresh":true}\n'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importConfiguration: creates a missing volume then restores with wipe', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-import-'));
  const zipPath = path.join(root, 'import.zip');
  fs.mkdirSync(path.join(root, '.e'), { recursive: true });
  // Archive carries omniroute-data so the volume restore path runs.
  const dataDir = path.join(root, 'omniroute-data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{}');
  const zip = new AdmZip();
  zip.addLocalFolder(dataDir, 'omniroute-data');
  zip.writeZip(zipPath);
  const runner = new RecordingRunner();
  runner.volumeExistsResult = false;
  try {
    await importConfiguration({ file: zipPath, root, runner });
    assert.ok(runner.calls.includes('volumeExists'));
    assert.deepEqual(runner.volumesCreated, [OMNIROUTE_VOLUME]);
    assert.equal(runner.copied[0]?.target, OMNIROUTE_VOLUME);
    assert.equal(runner.copied[0]?.wipe, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importConfiguration: existing volume restores with wipe but no create', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-import-'));
  const zipPath = path.join(root, 'import.zip');
  fs.mkdirSync(path.join(root, '.e'), { recursive: true });
  const dataDir = path.join(root, 'omniroute-data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{}');
  const zip = new AdmZip();
  zip.addLocalFolder(dataDir, 'omniroute-data');
  zip.writeZip(zipPath);
  const runner = new RecordingRunner();
  try {
    await importConfiguration({ file: zipPath, root, runner });
    assert.ok(runner.calls.includes('volumeExists'));
    assert.deepEqual(runner.volumesCreated, []);
    assert.equal(runner.copied[0]?.target, OMNIROUTE_VOLUME);
    assert.equal(runner.copied[0]?.wipe, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
