/**
 * **A child run**: one `e spawn` process whose result reaches its parent
 * through a Spool record. Two callers drive such a run - the `SiblingConsumer`
 * of a Run with a Runtime-broker (ADR-0013) and the A2A facade's tasks
 * (ADR-0015) - and both used to spell out the launch and the settle by hand,
 * which is how they came to disagree about which fields a settle keeps.
 *
 * This module owns the two ends: {@link startChildRun} spells the CLI
 * arguments, opens the log and hands back a handle, and
 * {@link settleChildRun} applies the one rule for what a process's exit means.
 * What sits between them - when to launch, how often to poll, what to do with
 * the branch afterwards - stays with each caller, because a queue consumer
 * with a fan-out cap and a request-per-call facade are not the same loop.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import {
  readStatus,
  spoolLogPath,
  writeStatus,
} from '../../sidecars/broker/contract/spool.js';
import type {
  SiblingStatusPatch,
  SpawnRequest,
} from '../../sidecars/broker/contract/types.js';
import {
  checkedSelfInvocation,
  type SelfInvocation,
} from '../../shared/utils/selfInvoke.js';
import { spawnArgs } from '../../shared/spawnArgs.js';

/** A launched child process, as its caller sees it. */
export interface ChildHandle {
  /** Resolves with the exit code once the process is gone (1 when it failed to start or was killed). */
  exited: Promise<number>;
  /** Asks the process to stop (a cancel, or a child that never became ready). */
  kill(): void;
}

/** What a launcher gets: the request, the CLI arguments, the environment carrying the markers, and where to log. */
export interface ChildLaunch {
  request: SpawnRequest;
  /** The arguments after the executable (and its entry script): `spawn <agent> ... -- <prompt>`. */
  args: string[];
  env: Record<string, string | undefined>;
  logFile: string;
  /** The spool the child reports its status into, under `request.id`. */
  spoolDir: string;
}

/** Starts one child run; production re-invokes the CLI, tests script one. */
export type ChildLauncher = (launch: ChildLaunch) => ChildHandle;

/**
 * The CLI arguments that start a child run: `spawn <agent> [passthrough...]
 * -- <prompt>`. A prompt means one-shot, which is what every child run is -
 * nobody is at a terminal to drive the harness TUI.
 */
export function childCliArgs(
  request: SpawnRequest,
  passthrough: readonly string[] = []
): string[] {
  return spawnArgs({
    agent: request.agent,
    prompt: request.prompt,
    passthrough,
  });
}

/**
 * The production launcher: re-invokes this CLI in the directory the parent
 * was started from (the repo), output appended to the spool log so a child
 * that dies before reporting can still say why. `invocation` is how to run
 * this CLI again (checked by {@link assertCliEntry} by default); tests pass a
 * scripted one.
 */
export function spawnChildProcess(
  launch: ChildLaunch,
  invocation: SelfInvocation = checkedSelfInvocation()
): ChildHandle {
  fs.mkdirSync(path.dirname(launch.logFile), { recursive: true });
  const out = fs.openSync(launch.logFile, 'a');
  let child;
  try {
    child = spawnProcess(
      invocation.command,
      [...invocation.prefix, ...launch.args],
      { cwd: process.cwd(), env: launch.env, stdio: ['ignore', out, out] }
    );
  } catch (err) {
    fs.closeSync(out);
    throw err;
  }
  const exited = new Promise<number>(resolve => {
    child.on('error', () => resolve(1));
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 0)));
  }).finally(() => fs.closeSync(out));
  return { exited, kill: () => child.kill('SIGTERM') };
}

/** The last `lines` of a child's log, joined, for a failure message; empty when there is none. */
export function logTail(logFile: string, lines = 3): string {
  try {
    const text = fs.readFileSync(logFile, 'utf8').trimEnd();
    return text === '' ? '' : text.split('\n').slice(-lines).join(' | ');
  } catch {
    return '';
  }
}

/** What {@link startChildRun} needs. */
export interface StartChildRun {
  /** The spool holding `request` and receiving the child's status. */
  spoolDir: string;
  request: SpawnRequest;
  /** The child's environment, including the `E_SPAWN_*` markers that give it its role. */
  env: Record<string, string | undefined>;
  /** `e spawn` arguments inherited from the parent's invocation (`--dir`, `--env-file`). */
  passthroughArgs?: readonly string[];
  /** Defaults to {@link spawnChildProcess}; tests script one. */
  launch?: ChildLauncher;
}

/** Where a request's child writes its output. Exposed so a caller can quote the tail on failure. */
export function childLogFile(spoolDir: string, id: string): string {
  return spoolLogPath(spoolDir, id);
}

/**
 * Starts the child process for `request`. Throws whatever the launcher throws
 * (the caller decides whether that is a failed request or a hard error).
 */
export function startChildRun(start: StartChildRun): ChildHandle {
  const launch = start.launch ?? spawnChildProcess;
  return launch({
    request: start.request,
    args: childCliArgs(start.request, start.passthroughArgs),
    env: start.env,
    logFile: childLogFile(start.spoolDir, start.request.id),
    spoolDir: start.spoolDir,
  });
}

/**
 * Records how far a child run got, into the Spool that watches it. `target` is
 * absent for a run nobody watches - a plain `e spawn` - so callers can report
 * unconditionally instead of guarding every call.
 *
 * Every write is a patch (see `writeStatus`), so a field an earlier report
 * recorded survives this one.
 */
export function reportChildRun(
  target: { spoolDir: string; id: string } | undefined,
  patch: Omit<SiblingStatusPatch, 'updatedAt'>,
  now: () => Date = () => new Date()
): void {
  if (!target) return;
  writeStatus(target.spoolDir, target.id, {
    ...patch,
    updatedAt: now().toISOString(),
  });
}

/** What {@link settleChildRun} needs to decide what a child's exit meant. */
export interface SettleChildRun {
  spoolDir: string;
  id: string;
  /** The exit code the handle resolved with. */
  code: number;
  /** True when this caller asked the child to stop; a cancel wins over whatever it reported. */
  canceling: boolean;
  /** Who asked, for the message: `canceled by <actor>`. */
  actor: string;
  /** A launch- or wait-side error, used instead of the generic "never reported" message. */
  reason?: string;
  now?: () => Date;
}

/**
 * The one rule for what a child process's exit means, in three branches:
 *
 *  - a cancel this caller asked for wins, whatever the child reported;
 *  - a child that exited without reporting a result has failed, and the tail
 *    of its log says why;
 *  - a child that reported `done` or `failed` is left exactly as it is.
 *
 * Every branch is a patch (see `writeStatus`), so a field an earlier write
 * recorded - the branch, `pushed`, the PR/MR url, the report path - survives.
 */
export function settleChildRun(settle: SettleChildRun): void {
  const { spoolDir, id, code, canceling, actor } = settle;
  const now = (settle.now ?? (() => new Date()))().toISOString();
  const previous = readStatus(spoolDir, id);
  if (canceling) {
    writeStatus(spoolDir, id, {
      status: 'canceled',
      error: `canceled by ${actor}`,
      exitCode: previous?.exitCode ?? code,
      updatedAt: now,
    });
    return;
  }
  if (previous?.status === 'done' || previous?.status === 'failed') return;
  const tail = logTail(childLogFile(spoolDir, id));
  writeStatus(spoolDir, id, {
    status: 'failed',
    exitCode: code,
    error:
      settle.reason ??
      `the e spawn process exited with code ${code} before reporting a result${tail ? `: ${tail}` : ''}`,
    updatedAt: now,
  });
}
