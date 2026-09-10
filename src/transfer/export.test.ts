import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

test('export discovers the initialized .e store in the current directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-export-'));
  const store = path.join(root, '.e');
  const binDir = path.join(root, 'bin');
  const output = path.join(root, 'export.zip');

  try {
    fs.mkdirSync(store);
    fs.mkdirSync(binDir);

    const expectedFiles = {
      '.env': 'SECRET=value\n',
      'config.json': '{"defaultHarness":"claude"}\n',
      'compose.yaml': 'services: {}\n',
      'bootstrap.sh': '#!/bin/sh\n',
    };

    for (const [name, content] of Object.entries(expectedFiles)) {
      fs.writeFileSync(path.join(store, name), content);
    }

    const fakeDocker = path.join(binDir, 'docker');
    fs.writeFileSync(fakeDocker, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const cli = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../index.js'
    );
    execFileSync(process.execPath, [cli, 'export', '--output', output], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
      stdio: 'pipe',
    });

    const zip = new AdmZip(output);
    for (const [name, content] of Object.entries(expectedFiles)) {
      assert.equal(zip.readAsText(name), content);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
