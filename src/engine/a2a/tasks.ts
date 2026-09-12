/**
 * The **tasks** behind `e serve`'s A2A endpoint (ADR-0015). An A2A task is
 * one run: `message/send` starts a headless `e spawn <agent> --
 * <prompt>` child (the ADR-0014 pattern) carrying the report markers, so the
 * run writes its status into a spool this process owns - the same records,
 * states and task-state mapping as sibling runs, read here and rendered as
 * A2A `Task` objects. Nothing of the run's orchestration lives in `serve`: it
 * launches a child and reads files (ADR-0010's BFF line). Tasks are kept in
 * memory like terminal sessions: a `serve` restart forgets the task view, not
 * the run (which lands on its branch and PR/MR like any other).
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ensureSpool,
  nextRequestId,
  readRecord,
  writeRequest,
} from '../../sidecars/broker/contract/spool.js';
import { isTerminalTaskState } from '../../sidecars/broker/contract/taskState.js';
import type {
  SiblingRecord,
  SpawnRequest,
  TaskState,
} from '../../sidecars/broker/contract/types.js';
import { env } from '../../shared/utils/env.js';
import { log } from '../../shared/utils/log.js';
import {
  settleChildRun,
  startChildRun,
  type ChildHandle,
  type ChildLauncher,
} from '../runs/childRun.js';
import { JsonRpcError } from './jsonRpc.js';
import {
  A2A_ERROR_CODES,
  JSON_RPC_ERROR_CODES,
  dataPart,
  partsText,
  textPart,
  toWireState,
  type WireArtifact,
  type WireMessage,
  type WireSendMessageParams,
  type WireStreamResult,
  type WireTask,
  type WireTaskStatus,
} from './wire.js';

export interface A2aTasksDeps {
  /** The spool this process owns for its tasks (under the worktrees dir, like broker spools). */
  spoolDir: string;
  /** True for a Store agent (or bare harness) a task may run as. */
  knownAgent: (name: string) => boolean;
  /** The agent a message without `metadata.agent` runs as (the store's default harness). */
  defaultAgent: string;
  /**
   * Starts the task's child run; defaults to re-invoking this executable
   * (`childRun.spawnChildProcess`). Tests script one.
   */
  launch?: ChildLauncher;
  /** How often the spool is re-read for changes. */
  pollIntervalMs?: number;
  now?: () => Date;
  newId?: () => string;
}

/** Everything `serve` remembers about one task. */
interface TaskEntry {
  id: string;
  contextId: string;
  /** The spool record id (`a2a-NNN`). */
  recordId: string;
  agent: string;
  prompt: string;
  /** The user's message, kept as the task's history. */
  message: WireMessage;
  child: ChildHandle;
  canceling: boolean;
  /** The last task state the listeners saw. */
  lastState: TaskState;
  createdAt: string;
  listeners: Set<(event: WireStreamResult) => void>;
}

const DEFAULT_POLL_INTERVAL_MS = 500;

/** Who cancels an A2A task, for `settleChildRun`'s message (`canceled by the A2A client`). */
const CANCEL_ACTOR = 'the A2A client';
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The one artifact a completed task has: the run's branch and PR/MR. */
export const RUN_ARTIFACT_NAME = 'run';

/** The agent a message asks for: `metadata.agent`, else `metadata.skillId`, on the message or the params. */
export function requestedAgent(
  params: WireSendMessageParams
): string | undefined {
  for (const metadata of [params.message?.metadata, params.metadata]) {
    if (!metadata) continue;
    for (const key of ['agent', 'skillId']) {
      const value = metadata[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
  }
  return undefined;
}

/** Validates `message/send` params into what a task needs; throws the JSON-RPC error otherwise. */
export function parseSendParams(
  raw: unknown,
  knownAgent: (name: string) => boolean,
  defaultAgent: string
): { agent: string; prompt: string; message: WireMessage } {
  const params = (raw ?? {}) as WireSendMessageParams;
  const message = params.message;
  if (typeof message !== 'object' || message === null) {
    throw new JsonRpcError(
      JSON_RPC_ERROR_CODES.invalidParams,
      '"params.message" is required.'
    );
  }
  if (!Array.isArray(message.parts)) {
    throw new JsonRpcError(
      JSON_RPC_ERROR_CODES.invalidParams,
      '"params.message.parts" must be an array.'
    );
  }
  if (message.taskId !== undefined) {
    throw new JsonRpcError(
      A2A_ERROR_CODES.unsupportedOperation,
      'Tasks take no follow-up messages: a run has no input channel once started. Send a new message with the whole task.'
    );
  }
  const prompt = partsText(message.parts).trim();
  if (prompt === '') {
    throw new JsonRpcError(
      A2A_ERROR_CODES.contentTypeNotSupported,
      'The message needs at least one text part: the task to run, as text.'
    );
  }
  if (params.configuration?.taskPushNotificationConfig !== undefined) {
    throw new JsonRpcError(
      A2A_ERROR_CODES.pushNotificationNotSupported,
      'Push notifications are not supported; use SendStreamingMessage or SubscribeToTask.'
    );
  }
  const agent = requestedAgent(params) ?? defaultAgent;
  if (!AGENT_NAME.test(agent) || !knownAgent(agent)) {
    throw new JsonRpcError(
      JSON_RPC_ERROR_CODES.invalidParams,
      `Unknown agent "${agent}"; name a skill of the agent card in metadata.agent.`
    );
  }
  return {
    agent,
    prompt,
    message: {
      ...message,
      messageId:
        typeof message.messageId === 'string' && message.messageId !== ''
          ? message.messageId
          : randomUUID(),
      role: 'ROLE_USER',
    },
  };
}

/** The one-line human summary that rides the artifact next to the data part. */
export function runSummary(record: SiblingRecord): string {
  const lines = [
    `Run ${record.branch ?? '(no branch)'} by agent ${record.agent}: exit code ${record.exitCode ?? '?'}.`,
  ];
  if (record.pushed) lines.push('The branch was pushed.');
  else
    lines.push(
      'The branch was not pushed (no commits beyond the base, or the push failed).'
    );
  if (record.pullRequestUrl)
    lines.push(`Pull/merge request: ${record.pullRequestUrl}`);
  return lines.join(' ');
}

/** The artifact of a completed run: branch, exit code, pushed, PR/MR URL. */
export function runArtifact(record: SiblingRecord): WireArtifact {
  return {
    artifactId: `${record.id}-run`,
    name: RUN_ARTIFACT_NAME,
    description: 'The run branch and its pull/merge request',
    parts: [
      dataPart({
        branch: record.branch ?? null,
        exitCode: record.exitCode ?? null,
        pushed: record.pushed ?? false,
        pullRequestUrl: record.pullRequestUrl ?? null,
      }),
      textPart(runSummary(record)),
    ],
  };
}

/**
 * Browser-started runs' sibling (ADR-0014): A2A-started runs. Each task is
 * one headless `e spawn` child reporting into this process's spool.
 */
export class A2aTasks {
  private readonly tasks = new Map<string, TaskEntry>();
  private readonly spoolDir: string;
  private readonly knownAgent: (name: string) => boolean;
  private readonly defaultAgent: string;
  private readonly launch: ChildLauncher | undefined;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private poll: NodeJS.Timeout | undefined;

  constructor(deps: A2aTasksDeps) {
    this.spoolDir = deps.spoolDir;
    this.knownAgent = deps.knownAgent;
    this.defaultAgent = deps.defaultAgent;
    this.launch = deps.launch;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
    ensureSpool(this.spoolDir);
  }

  /** `message/send`: validates, spools the request, starts the run, returns the task as `submitted`. */
  send(params: unknown): WireTask {
    const { agent, prompt, message } = parseSendParams(
      params,
      this.knownAgent,
      this.defaultAgent
    );
    const recordId = nextRequestId(this.spoolDir, 'a2a');
    const at = this.now().toISOString();
    const request: SpawnRequest = {
      id: recordId,
      agent,
      prompt,
      requestedAt: at,
    };
    writeRequest(this.spoolDir, request);
    const id = this.newId();
    const contextId =
      typeof message.contextId === 'string' && message.contextId !== ''
        ? message.contextId
        : this.newId();
    const child = startChildRun({
      spoolDir: this.spoolDir,
      request,
      env: env.withReport({ spoolDir: this.spoolDir, id: recordId }),
      launch: this.launch,
    });
    const entry: TaskEntry = {
      id,
      contextId,
      recordId,
      agent,
      prompt,
      message: { ...message, taskId: id, contextId },
      child,
      canceling: false,
      lastState: 'submitted',
      createdAt: at,
      listeners: new Set(),
    };
    this.tasks.set(id, entry);
    child.exited.then(
      code => this.onExit(entry, code),
      () => this.onExit(entry, 1)
    );
    this.ensurePolling();
    log.info(`A2A task ${id}: started ${agent} as ${recordId}`);
    return this.render(entry);
  }

  /** `tasks/get`; a {@link JsonRpcError} `TaskNotFound` for an unknown id. */
  get(id: unknown): WireTask {
    return this.render(this.entry(id));
  }

  /** `tasks/list`: every task this process remembers, newest first. */
  list(): WireTask[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(entry => this.render(entry));
  }

  /**
   * `tasks/cancel`: stops the run (the child stops its container on SIGTERM)
   * and reports `canceled` when it has exited; a task already over is
   * `TaskNotCancelable`.
   */
  cancel(id: unknown): WireTask {
    const entry = this.entry(id);
    const record = this.record(entry);
    if (isTerminalTaskState(record.taskState)) {
      throw new JsonRpcError(
        A2A_ERROR_CODES.taskNotCancelable,
        `Task ${entry.id} is already ${record.taskState}.`
      );
    }
    if (!entry.canceling) {
      entry.canceling = true;
      log.info(
        `A2A task ${entry.id}: cancel requested, stopping ${entry.recordId}`
      );
      entry.child.kill();
    }
    return this.render(entry);
  }

  /**
   * Streams a task's changes: `statusUpdate` on every state change, the run
   * artifact before the final `completed` update, `final: true` on the last
   * one. A task already over gets its final events at once. Returns the
   * unsubscribe.
   */
  subscribe(
    id: unknown,
    listener: (event: WireStreamResult) => void
  ): () => void {
    const entry = this.entry(id);
    const record = this.record(entry);
    if (isTerminalTaskState(record.taskState)) {
      for (const event of this.finalEvents(entry, record)) listener(event);
      return () => undefined;
    }
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  /** Stops polling and forgets every task; the runs keep going. */
  dispose(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    for (const entry of this.tasks.values()) entry.listeners.clear();
    this.tasks.clear();
  }

  private entry(id: unknown): TaskEntry {
    const entry = typeof id === 'string' ? this.tasks.get(id) : undefined;
    if (!entry) {
      throw new JsonRpcError(
        A2A_ERROR_CODES.taskNotFound,
        `Unknown task${typeof id === 'string' ? ` "${id}"` : ''}.`
      );
    }
    return entry;
  }

  private record(entry: TaskEntry): SiblingRecord {
    const record = readRecord(this.spoolDir, entry.recordId);
    if (record) return record;
    return {
      id: entry.recordId,
      agent: entry.agent,
      prompt: entry.prompt,
      requestedAt: entry.createdAt,
      status: 'requested',
      taskState: 'submitted',
    };
  }

  private ensurePolling(): void {
    if (this.poll) return;
    this.poll = setInterval(() => this.tick(), this.pollIntervalMs);
    this.poll.unref?.();
  }

  /** One pass over the live tasks: a state change is an event for the listeners. */
  tick(): void {
    let live = false;
    for (const entry of this.tasks.values()) {
      const record = this.record(entry);
      if (record.taskState !== entry.lastState) {
        entry.lastState = record.taskState;
        const events = isTerminalTaskState(record.taskState)
          ? this.finalEvents(entry, record)
          : [this.statusEvent(entry, record, false)];
        for (const listener of [...entry.listeners]) {
          for (const event of events) listener(event);
        }
        if (isTerminalTaskState(record.taskState)) {
          entry.listeners.clear();
        }
      }
      if (!isTerminalTaskState(record.taskState)) live = true;
    }
    if (!live && this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  /**
   * The run's process is gone. A cancel the run answered is `canceled`
   * whatever it reported; a process that never reported a result failed.
   */
  private onExit(entry: TaskEntry, code: number): void {
    settleChildRun({
      spoolDir: this.spoolDir,
      id: entry.recordId,
      code,
      canceling: entry.canceling,
      actor: CANCEL_ACTOR,
      now: this.now,
    });
    this.tick();
  }

  private status(record: SiblingRecord): WireTaskStatus {
    const status: WireTaskStatus = {
      state: toWireState(record.taskState),
      timestamp: record.updatedAt ?? record.requestedAt,
    };
    const note =
      record.taskState === 'failed' ||
      record.taskState === 'canceled' ||
      record.taskState === 'rejected'
        ? (record.error ??
          (record.exitCode !== undefined && record.exitCode !== 0
            ? `the run exited with code ${record.exitCode}; nothing was committed`
            : undefined))
        : undefined;
    if (note) {
      status.message = {
        messageId: `${record.id}-${record.taskState}`,
        role: 'ROLE_AGENT',
        parts: [textPart(note)],
      };
    }
    return status;
  }

  private render(entry: TaskEntry): WireTask {
    const record = this.record(entry);
    const task: WireTask = {
      id: entry.id,
      contextId: entry.contextId,
      status: this.status(record),
      history: [entry.message],
      metadata: {
        agent: entry.agent,
        requestId: entry.recordId,
        ...(record.branch !== undefined ? { branch: record.branch } : {}),
      },
    };
    if (record.taskState === 'completed') {
      task.artifacts = [runArtifact(record)];
    }
    return task;
  }

  private statusEvent(
    entry: TaskEntry,
    record: SiblingRecord,
    final: boolean
  ): WireStreamResult {
    return {
      statusUpdate: {
        taskId: entry.id,
        contextId: entry.contextId,
        status: this.status(record),
        final,
        metadata: {
          requestId: entry.recordId,
          ...(record.branch !== undefined ? { branch: record.branch } : {}),
        },
      },
    };
  }

  private finalEvents(
    entry: TaskEntry,
    record: SiblingRecord
  ): WireStreamResult[] {
    const events: WireStreamResult[] = [];
    if (record.taskState === 'completed') {
      events.push({
        artifactUpdate: {
          taskId: entry.id,
          contextId: entry.contextId,
          artifact: runArtifact(record),
          append: false,
          lastChunk: true,
        },
      });
    }
    events.push(this.statusEvent(entry, record, true));
    return events;
  }
}

/** The spool of one `serve` process's A2A tasks, next to the broker spools. */
export function a2aSpoolDirFor(worktreesDir: string, pid: number): string {
  return path.join(worktreesDir, '.a2a', `serve-${pid}`);
}

/** Best-effort removal of a `serve` process's task spool at shutdown. */
export function removeA2aSpool(spoolDir: string): void {
  fs.rmSync(spoolDir, { recursive: true, force: true });
}
