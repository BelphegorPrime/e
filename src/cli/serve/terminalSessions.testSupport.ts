import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import type { ContainerRef, EngineApi } from './containerApi.js';
import type { SpawnedChild } from './terminalSessions.js';

/*
 * Test doubles for the browser terminal, shared by the sessions, socket and
 * serve tests. Not a test file itself (the `*.test.js` glob skips it), so
 * importing it does not re-register another file's tests.
 */

/** A scripted `e spawn` child: the test writes its output and ends it. */
export interface FakeChild extends SpawnedChild {
  stdout: PassThrough;
  stderr: PassThrough;
  exit(code: number): void;
  fail(error: Error): void;
}

export function scriptedSpawner(): {
  spawn: (args: string[]) => SpawnedChild;
  calls: string[][];
  children: FakeChild[];
} {
  const calls: string[][] = [];
  const children: FakeChild[] = [];
  return {
    calls,
    children,
    spawn: args => {
      calls.push(args);
      const emitter = new EventEmitter();
      const child = Object.assign(emitter, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exit: (code: number) => emitter.emit('exit', code, null),
        fail: (error: Error) => emitter.emit('error', error),
      }) as unknown as FakeChild;
      children.push(child);
      return child;
    },
  };
}

export interface FakeEngineState {
  containers: ContainerRef[];
  /** The attach stream handed out; the test writes container output into `toBrowser`. */
  attached?: { toBrowser: PassThrough; fromBrowser: PassThrough };
  resizes: Array<{ container: string; cols: number; rows: number }>;
  attachError?: Error;
}

export function fakeEngine(
  initial: Partial<FakeEngineState>
): EngineApi & { state: FakeEngineState } {
  const state: FakeEngineState = {
    containers: [],
    resizes: [],
    ...initial,
  };
  return {
    state,
    async findContainer(pattern) {
      const regex = new RegExp(pattern);
      return state.containers.find(container =>
        regex.test(`/${container.name}`)
      );
    },
    async attach() {
      if (state.attachError) throw state.attachError;
      const toBrowser = new PassThrough();
      const fromBrowser = new PassThrough();
      state.attached = { toBrowser, fromBrowser };
      // Readable side: whatever the test writes into `toBrowser`; writable
      // side: keystrokes, surfaced on `fromBrowser`.
      const stream = new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, callback) {
          fromBrowser.write(chunk);
          callback();
        },
      });
      toBrowser.on('data', chunk => stream.push(chunk));
      return stream;
    },
    async resize(container, cols, rows) {
      state.resizes.push({ container, cols, rows });
    },
  };
}
