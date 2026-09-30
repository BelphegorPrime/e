/**
 * **The fan-out of a Fusion run** (ADR-0019 sections 3, 4 and 9): one task to
 * every candidate Agent of a profile, each an ordinary `e spawn` child - its
 * own worktree, branch and container - cut from one base pinned before the
 * first launch, and each collected into the fusion record whatever became
 * of it.
 *
 * The coordinator sits above the run machinery rather than inside it: a
 * candidate is launched through `childRun.ts`, like a Sibling run or an A2A
 * task, and told what makes it a candidate by host-set markers (the pinned
 * base, the fusion's spool; it pushes nothing and opens no PR), so no
 * harness, adapter or provider knows it is part of a fusion.
 *
 * - **At most `maxConcurrency` alive**, launched in profile order as slots
 *   free, and **one image build at a time**: the next candidate starts only
 *   once every earlier one has built and cut its worktree (`starting`), so N
 *   candidates never race one build, and a later candidate of an Agent whose
 *   image is fresh passes `--no-rebuild`.
 * - **A failure discards nothing**: a candidate that fails, is empty or
 *   cannot even launch gets its envelope, and the others go on.
 * - **The close pushes every usable branch**, after the last candidate has
 *   stopped, so no candidate can read a rival off the remote mid-run.
 * - **A cancel** kills every candidate alive, launches none of the rest, and
 *   pushes nothing; each still gets its envelope.
 */

import fs from 'node:fs';
import path from 'node:path';
import { monotonicFactory } from 'ulid';
import type { HarnessAgent } from '../../core/agent/agent.js';
import type { FoundFusionProfile } from '../../core/fusion/load.js';
import { isUsable, type CandidateResult } from '../../core/fusion/result.js';
import { HARNESSES } from '../../core/harness/index.js';
import type { Git } from '../../ports/git/index.js';
import {
  ensureSpool,
  nextRequestId,
  readStatus,
  writeRequest,
} from '../../sidecars/broker/contract/spool.js';
import type { SpawnRequest } from '../../sidecars/broker/contract/types.js';
import { SPAWN_FLAGS } from '../../shared/spawnArgs.js';
import { env } from '../../shared/utils/env.js';
import { errorMessage } from '../../shared/utils/errors.js';
import { log } from '../../shared/utils/log.js';
import {
  settleChildRun,
  startChildRun,
  type ChildHandle,
  type ChildLauncher,
} from '../runs/childRun.js';
import type { RunBase } from '../runs/runSpawn.js';
import { collectCandidateResult, type SettledCandidate } from './collect.js';
import {
  pruneFusions,
  reconcileFusions,
  writeFusionRecord,
  type FusionAgentSnapshot,
  type FusionRecord,
  type FusionState,
} from './record.js';

/** Where the children's spools live under the worktrees dir: `.fusion/<fusion id>`. */
const FUSION_SPOOLS_DIR = '.fusion';

/** Who stops a candidate, as its status says (`canceled by the fusion`). */
const FUSION_ACTOR = 'the fusion';

/** The exit code of a candidate whose `e spawn` could not even start, as `settleChildRun` records it. */
const LAUNCH_FAILED_EXIT_CODE = 1;

/**
 * How long a live candidate holds the next launch back while it builds.
 * Builds are one at a time so they never race; past this, a hung build no
 * longer holds every other candidate back (its own caps are #178's).
 */
export const DEFAULT_BUILD_GATE_MS = 20 * 60 * 1000;

const newUlid = monotonicFactory();

/** What a fan-out runs on. */
export interface FanOutDeps {
  /** The checkout's repository: the base is pinned here and the branches pushed from here. */
  git: Git;
  /** The checkout's `.e/`: the fusion record lives in it. */
  storeDir: string;
  /** Where the children's spool goes, beside the run worktrees. */
  worktreesDir: string;
  /** Starts one candidate; defaults to re-invoking this CLI. Tests script one. */
  launch?: ChildLauncher;
  /** `e spawn` arguments every candidate inherits (`--dir`, `--env-file`, `--runtime`). */
  passthroughArgs?: readonly string[];
  /** The environment the candidates' is derived from; `process.env` by default. */
  baseEnv?: Record<string, string | undefined>;
  /** Keep the spool and the children's logs when the fusion ends here (`--keep-worktree`). */
  keepSpool?: boolean;
  /** How often the children are checked on; an exit or a cancel wakes the loop at once. */
  pollIntervalMs?: number;
  /** See {@link DEFAULT_BUILD_GATE_MS}. */
  buildGateMs?: number;
  now?: () => Date;
  newFusionId?: () => string;
  /** Whether a recorded coordinator is still running; for reconciling old records. */
  isAlive?: (pid: number) => boolean;
}

/** What one fan-out is asked. */
export interface FanOutParams {
  /** The profile, its Agents resolved (`findFusionProfile`). */
  found: FoundFusionProfile;
  /** The task, as every candidate gets it. */
  prompt: string;
  /** A cancel: Ctrl-C, SIGTERM, or a caller giving up. */
  abort?: AbortSignal;
  /** Progress, for the CLI to render. */
  onEvent?: (event: FanOutEvent) => void;
}

/** What the fan-out reports as it goes. */
export type FanOutEvent =
  | { kind: 'launched'; candidate: string; agent: string }
  | { kind: 'settled'; candidate: string; result: CandidateResult }
  | {
      kind: 'closed';
      usable: number;
      pushed: string[];
      pushWarnings: string[];
    };

/** How the fan-out ended. */
export interface FanOutResult {
  fusion: string;
  base: RunBase;
  /**
   * `fanning-out` when the fan-out closed and the synthesis may start - the
   * Fusion run is still live, and its record says so; `failed` or
   * `canceled` when it ended here.
   */
  state: FusionState;
  reason?: string;
  /** Every candidate attempt, in launch order. */
  candidates: CandidateResult[];
  /** The ones with commits beyond the base, whatever their verdict. */
  usable: CandidateResult[];
  /** The usable branches pushed when the fan-out closed. */
  pushed: string[];
  pushWarnings: string[];
  /** The children's spool, with their logs: removed when the fusion ends. */
  spoolDir: string;
}

/** One candidate the fan-out is driving. */
interface Slot {
  request: SpawnRequest;
  agent: HarnessAgent;
  /** True once a launch was attempted, whether or not the process started. */
  launched?: boolean;
  handle?: ChildHandle;
  startedAt?: Date;
  /** The code the process exited with, once it has. */
  code?: number;
  /** True when the fusion killed it. */
  killed?: boolean;
}

/**
 * Runs the fan-out of one Fusion run and returns every candidate's result.
 * Throws only before anything has started: no repository, a detached HEAD,
 * an empty prompt.
 */
export async function runFanOut(
  deps: FanOutDeps,
  params: FanOutParams
): Promise<FanOutResult> {
  const now = deps.now ?? (() => new Date());
  const { profile, agents } = params.found;
  const prompt = params.prompt.trim();
  if (prompt === '') {
    throw new Error(`Fusion "${profile.name}" needs a prompt.`);
  }

  // The base, pinned once: a `git pull` while a candidate waits for a slot
  // must not give it a different start (ADR-0019 section 4).
  const sha = deps.git.headSha();
  const branch = deps.git.currentBranch();
  if (branch === '') {
    throw new Error(
      'A fusion proposes its result into the branch it started from, and this checkout is on a detached HEAD; check out a branch first.'
    );
  }
  const base: RunBase = { sha, ref: `refs/heads/${branch}`, branch };

  // Before this fusion's record exists: what a dead coordinator left is
  // interrupted, and what ended long ago is pruned.
  reconcileFusions(deps.storeDir, { isAlive: deps.isAlive, now: now() });
  pruneFusions(deps.storeDir, now());

  const fusion = deps.newFusionId?.() ?? `fusion-${newUlid()}`;
  const spoolDir = fusionSpoolDir(deps.worktreesDir, fusion);
  ensureSpool(spoolDir);
  const slots: Slot[] = profile.candidates.map(name => {
    const request: SpawnRequest = {
      id: nextRequestId(spoolDir, 'cand'),
      agent: name,
      prompt,
      requestedAt: now().toISOString(),
    };
    writeRequest(spoolDir, request);
    return { request, agent: agents.get(name)! };
  });

  const createdAt = now().toISOString();
  let record: FusionRecord = {
    schemaVersion: 1,
    fusion,
    state: 'prepared',
    profile,
    agents: snapshot(agents),
    prompt,
    base,
    candidates: slots.map(slot => slot.request.id),
    coordinator: { pid: process.pid },
    createdAt,
    updatedAt: createdAt,
  };
  const save = (patch: Partial<FusionRecord>): void => {
    record = { ...record, ...patch, updatedAt: now().toISOString() };
    writeFusionRecord(deps.storeDir, record);
  };
  save({});

  const results = new Map<string, CandidateResult>();
  const collect = (slot: Slot, stoppedBy?: 'cancel'): void => {
    const status = readStatus(spoolDir, slot.request.id);
    const ended = now();
    const settled: SettledCandidate = {
      fusion,
      candidate: slot.request.id,
      agent: slot.agent,
      harnessVersion: harnessVersionOf(slot.agent),
      base: { sha, branch },
      ...(status?.branch !== undefined ? { branch: status.branch } : {}),
      // A candidate that never launched has no exit code to report.
      ...(slot.launched
        ? { exitCode: status?.exitCode ?? slot.code ?? LAUNCH_FAILED_EXIT_CODE }
        : {}),
      ...(stoppedBy ? { stoppedBy } : {}),
      ...(status?.reason !== undefined ? { reason: status.reason } : {}),
      ...(status?.verify !== undefined ? { verify: status.verify } : {}),
      attempt: 1,
      startedAt: slot.startedAt ?? ended,
      endedAt: ended,
    };
    let result: CandidateResult;
    try {
      result = collectCandidateResult(deps.git, deps.storeDir, settled);
    } catch (err) {
      // One unreadable branch costs the fusion that candidate, not the rest.
      log.warn(
        `Could not collect ${slot.request.id} (${slot.agent.name}): ${errorMessage(err)}`
      );
      result = collectCandidateResult(deps.git, deps.storeDir, {
        ...settled,
        unreadable: true,
      });
    }
    results.set(slot.request.id, result);
    params.onEvent?.({ kind: 'settled', candidate: slot.request.id, result });
  };

  const pending = [...slots];
  const alive: Slot[] = [];
  /** Agents whose image a candidate has already built in this fan-out. */
  const built = new Set<string>();
  let canceling = false;
  const waker = new Waker();

  const launch = (slot: Slot): void => {
    const reuse = built.has(slot.agent.name);
    slot.startedAt = now();
    slot.launched = true;
    let handle: ChildHandle;
    try {
      handle = startChildRun({
        spoolDir,
        request: slot.request,
        env: env.withFusionCandidate(
          { spoolDir, id: slot.request.id },
          { fusion, base },
          deps.baseEnv ?? process.env
        ),
        passthroughArgs: [
          ...(deps.passthroughArgs ?? []),
          ...(reuse ? [SPAWN_FLAGS.noRebuild] : []),
        ],
        ...(deps.launch ? { launch: deps.launch } : {}),
      });
    } catch (err) {
      settleChildRun({
        spoolDir,
        id: slot.request.id,
        code: LAUNCH_FAILED_EXIT_CODE,
        canceling: false,
        actor: FUSION_ACTOR,
        reason: `could not start the e spawn process: ${errorMessage(err)}`,
        now,
      });
      collect(slot);
      return;
    }
    slot.handle = handle;
    // The one reaction per child: record the code and wake the loop.
    void handle.exited.then(code => {
      slot.code = code;
      waker.wake();
    });
    alive.push(slot);
    params.onEvent?.({
      kind: 'launched',
      candidate: slot.request.id,
      agent: slot.agent.name,
    });
  };

  const pollMs = deps.pollIntervalMs ?? 1000;
  const gateMs = deps.buildGateMs ?? DEFAULT_BUILD_GATE_MS;
  const onAbort = (): void => waker.wake();
  params.abort?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      // Settle whatever has exited first, so a candidate that finished just
      // before a cancel is recorded as finished, not as canceled.
      for (const slot of [...alive]) {
        if (slot.code === undefined) continue;
        alive.splice(alive.indexOf(slot), 1);
        settleChildRun({
          spoolDir,
          id: slot.request.id,
          code: slot.code,
          canceling: slot.killed === true,
          actor: FUSION_ACTOR,
          now,
        });
        collect(slot, slot.killed ? 'cancel' : undefined);
      }
      if (params.abort?.aborted && !canceling) {
        canceling = true;
        for (const slot of alive) {
          slot.killed = true;
          slot.handle!.kill();
        }
        // What never started is canceled all the same, and says so.
        for (const slot of pending.splice(0)) collect(slot, 'cancel');
      }
      // A candidate has built its images once it reports its branch: that is
      // `starting`, after the builds and the worktree (ADR-0005).
      let building = false;
      for (const slot of alive) {
        if (readStatus(spoolDir, slot.request.id)?.branch !== undefined) {
          built.add(slot.agent.name);
        } else if (now().getTime() - slot.startedAt!.getTime() < gateMs) {
          building = true;
        }
      }
      // One build at a time: nothing else starts while a live candidate is
      // still building - unless it has been at it past the gate, so one hung
      // build cannot hold every other candidate back forever.
      while (
        !canceling &&
        !building &&
        pending.length > 0 &&
        alive.length < profile.maxConcurrency
      ) {
        const slot = pending.shift()!;
        launch(slot);
        if (slot.handle) building = true;
      }
      if (alive.length === 0 && pending.length === 0) break;
      await waker.sleep(pollMs);
    }
  } catch (err) {
    // Whatever broke the loop, no candidate outlives it and the record says
    // so; the spool stays, with the logs, for whoever looks next.
    for (const slot of alive) slot.handle?.kill();
    save({
      state: 'failed',
      reason: 'aborted:fusion-coordinator',
      endedAt: now().toISOString(),
    });
    throw err;
  } finally {
    params.abort?.removeEventListener('abort', onAbort);
  }

  // The fan-out is closed: every candidate has stopped.
  const candidates = slots.map(slot => results.get(slot.request.id)!);
  const usable = candidates.filter(isUsable);
  const pushed: string[] = [];
  const pushWarnings: string[] = [];
  let state: FusionState = 'fanning-out';
  let reason: string | undefined;
  if (canceling) {
    // A canceled fusion pushes nothing, as a canceled run does not (ADR-0015).
    state = 'canceled';
  } else {
    for (const branchName of new Set(usable.map(result => result.branch!))) {
      try {
        deps.git.push(branchName);
        pushed.push(branchName);
      } catch (err) {
        pushWarnings.push(`could not push ${branchName}: ${errorMessage(err)}`);
      }
    }
    if (usable.length < profile.minUsable) {
      state = 'failed';
      reason = 'aborted:no-usable-candidate';
    }
  }
  params.onEvent?.({
    kind: 'closed',
    usable: usable.length,
    pushed,
    pushWarnings,
  });
  const closedAt = now().toISOString();
  save({
    state,
    ...(reason !== undefined ? { reason } : {}),
    fanOut: { closedAt, usable: usable.length, pushed, pushWarnings },
    ...(state === 'fanning-out' ? {} : { endedAt: closedAt }),
  });
  // The logs go when the fusion ends; a fusion that goes on to its synthesis
  // leaves them for the step that ends it (`removeFusionSpool`).
  if (state !== 'fanning-out' && !deps.keepSpool) {
    removeFusionSpool(deps.worktreesDir, fusion);
  }

  return {
    fusion,
    base,
    state,
    ...(reason !== undefined ? { reason } : {}),
    candidates,
    usable,
    pushed,
    pushWarnings,
    spoolDir,
  };
}

/** The spool of a Fusion run's children, beside the run worktrees. */
export function fusionSpoolDir(worktreesDir: string, fusion: string): string {
  return path.join(worktreesDir, FUSION_SPOOLS_DIR, fusion);
}

/** Removes a Fusion run's spool and its children's logs: a log holds tool output, and tool output holds secrets. */
export function removeFusionSpool(worktreesDir: string, fusion: string): void {
  fs.rmSync(fusionSpoolDir(worktreesDir, fusion), {
    recursive: true,
    force: true,
  });
}

/** The pinned version of an Agent's harness, as the envelope and the record carry it. */
function harnessVersionOf(agent: HarnessAgent): string {
  return HARNESSES[agent.harness]?.version ?? 'unknown';
}

/** The resolved Agents as the record keeps them: identities, never a key or an endpoint. */
function snapshot(
  agents: ReadonlyMap<string, HarnessAgent>
): FusionAgentSnapshot[] {
  return [...agents.values()].map(agent => ({
    name: agent.name,
    harness: agent.harness,
    harnessVersion: harnessVersionOf(agent),
    provider: agent.provider
      ? { protocol: agent.provider.protocol, model: agent.provider.model }
      : null,
    skills: [...(agent.skills ?? [])],
  }));
}

/**
 * The loop's one wake-up source: a sleep that a child's exit or a cancel
 * ends early. One pending sleep at a time, and each child adds exactly one
 * reaction for its whole life, however long the fan-out polls.
 */
class Waker {
  private pending?: () => void;

  wake(): void {
    this.pending?.();
  }

  sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = (): void => {
        clearTimeout(timer);
        if (this.pending === done) this.pending = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.pending = done;
    });
  }
}
