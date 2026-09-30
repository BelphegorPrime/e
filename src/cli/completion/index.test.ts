import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { registerCompletion } from './index.js';
import { registerFuseCommand } from '../fuse.js';
import { RUNTIME_NAMES } from '../../ports/runtime/registry.js';

// Shell completion: `e fuse` completes the Store's fusion profiles and the
// runtimes, the dynamic parts the command tree alone cannot know.

test('registerCompletion: e fuse completes the fusion profiles of the Store it stands in, and --runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-completion-'));
  const cwd = process.cwd();
  try {
    for (const name of ['coding', 'review']) {
      fs.mkdirSync(path.join(root, '.e', 'fusions', name), { recursive: true });
    }
    process.chdir(root);
    const program = new Command();
    registerFuseCommand(program);
    const fuse = registerCompletion(program).commands.get('fuse');
    assert.ok(fuse, 'fuse is in the completion tree');

    const collect = (
      handler: ((complete: (value: string) => void) => void) | undefined
    ): string[] => {
      const values: string[] = [];
      handler?.(value => values.push(value));
      return values;
    };
    const profile = fuse.arguments.get('profile')!;
    assert.deepEqual(
      collect(complete =>
        profile.handler!.call(profile, complete, new Map())
      ).sort(),
      ['coding', 'review']
    );
    const runtime = fuse.options.get('runtime')!;
    assert.deepEqual(
      collect(complete => runtime.handler!.call(runtime, complete, new Map())),
      [...RUNTIME_NAMES]
    );
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
