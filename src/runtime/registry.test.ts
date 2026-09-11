import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIMES,
  RUNTIME_NAMES,
  isRuntimeName,
  resolveRuntimeWith,
} from './registry.js';

/** A fake runtime whose availability is decided by the `available` set. */
function fakeFactory(available: string[]) {
  const created: string[] = [];
  const create = (command: string) => {
    created.push(command);
    return {
      command,
      isAvailable: () => available.includes(command),
    };
  };
  return { create, created };
}

test('registry: every Docker-CLI-compatible engine is registered, docker first', () => {
  assert.deepEqual(RUNTIME_NAMES, ['docker', 'podman', 'nerdctl', 'finch']);
  for (const runtime of RUNTIMES) {
    assert.ok(runtime.label.length > 0, `${runtime.name} has a label`);
  }
  assert.ok(isRuntimeName('podman'));
  assert.ok(!isRuntimeName('sbx'));
});

test('resolveRuntimeWith: auto-detects the first available runtime in registry order', () => {
  const { create, created } = fakeFactory(['nerdctl', 'finch']);
  const runtime = resolveRuntimeWith(undefined, {}, create);
  assert.equal(runtime.command, 'nerdctl');
  assert.deepEqual(created, ['docker', 'podman', 'nerdctl']);
});

test('resolveRuntimeWith: --runtime wins and is probed only once', () => {
  const { create, created } = fakeFactory(['docker', 'podman']);
  const runtime = resolveRuntimeWith('podman', { E_RUNTIME: 'docker' }, create);
  assert.equal(runtime.command, 'podman');
  assert.deepEqual(created, ['podman']);
});

test('resolveRuntimeWith: E_RUNTIME selects the runtime when no flag is given', () => {
  const { create } = fakeFactory(['docker', 'finch']);
  const runtime = resolveRuntimeWith(
    undefined,
    { E_RUNTIME: ' finch ' },
    create
  );
  assert.equal(runtime.command, 'finch');
});

test('resolveRuntimeWith: an unknown name is rejected, naming its source', () => {
  const { create } = fakeFactory(['docker']);
  assert.throws(
    () => resolveRuntimeWith('sbx', {}, create),
    /Invalid runtime "sbx" \(from --runtime\)\. Valid values: docker, podman, nerdctl, finch\./
  );
  assert.throws(
    () => resolveRuntimeWith(undefined, { E_RUNTIME: 'lima' }, create),
    /Invalid runtime "lima" \(from E_RUNTIME\)/
  );
});

test('resolveRuntimeWith: a requested runtime that is not installed is an error', () => {
  const { create } = fakeFactory(['docker']);
  assert.throws(
    () => resolveRuntimeWith('podman', {}, create),
    /Requested runtime "podman" \(from --runtime\) is not installed or not on PATH\./
  );
});

test('resolveRuntimeWith: no runtime at all lists every option', () => {
  const { create } = fakeFactory([]);
  assert.throws(
    () => resolveRuntimeWith(undefined, {}, create),
    /No container runtime found\. Install one of docker, podman, nerdctl, finch/
  );
});
