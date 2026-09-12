import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import {
  AgentCard,
  CancelTaskRequest,
  GetTaskRequest,
  ListTasksRequest,
  SendMessageRequest,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatusUpdateEvent,
  taskStateToJSON,
  type StreamResponse,
} from '@a2a-js/sdk';
import {
  ClientFactory,
  ClientFactoryOptions,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import {
  agentCardHandler,
  jsonRpcHandler,
  UserBuilder,
} from '@a2a-js/sdk/server/express';
import {
  ensureSpool,
  readRecord,
  readStatus,
  writeRequest,
  writeStatus,
} from '../broker/spool.js';
import { createServeApp, startServeServer } from '../serve/serve.js';
import { A2aClient, taskAnswer, wireTaskState } from './client.js';
import type { RemoteA2aAgent } from './remoteAgent.js';
import { remoteSiblingProcess } from './remoteSibling.js';
import { runRemoteAgent } from './remoteSpawn.js';
import { A2aTasks } from './tasks.js';

// Interoperability with the reference implementation, `@a2a-js/sdk` (the
// official A2A JavaScript SDK, protocol 1.0), in both directions:
//
//  1. Its **client** drives `e serve`'s facade (ADR-0015): resolves the
//     card, sends messages, streams, gets, lists and cancels tasks, and
//     presents a bearer token. What the SDK cannot parse, an orchestrator
//     built on it cannot use - so these run against the real Express app.
//  2. Its **server** (`DefaultRequestHandler` + an `AgentExecutor`) plays a
//     remote agent for `e`'s client: a Store agent with `transport: "a2a"`
//     as a top-level spawn and as a sibling, including a cancel.
//
// The runs themselves are faked (a scripted `spawnChild`); the wire is real.

// --- 1. The SDK client against e serve -------------------------------------

interface Facade {
  baseUrl: string;
  spool: string;
  launches: string[][];
  close: () => Promise<void>;
}

async function startFacade(token?: string): Promise<Facade> {
  const uiDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'e-interop-ui-'));
  fs.writeFileSync(path.join(uiDirectory, 'index.html'), '<title>e</title>');
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'e-interop-spool-'));
  const launches: string[][] = [];
  const tasks = new A2aTasks({
    spoolDir: spool,
    knownAgent: name => name === 'pi' || name === 'smart-codex',
    defaultAgent: 'pi',
    spawnChild: args => {
      launches.push(args);
      return { exited: new Promise<number>(() => {}), kill: () => {} };
    },
    pollIntervalMs: 20,
  });
  // The URL the card advertises must be the real one: the SDK client calls
  // exactly what the card says.
  let server: Server | undefined = undefined;
  const app = createServeApp(uiDirectory, {
    a2a: {
      tasks,
      access:
        token === undefined
          ? { enabled: true, requireBearer: false }
          : { enabled: true, requireBearer: true, token },
      get url() {
        const address = server?.address();
        const port = address && typeof address !== 'string' ? address.port : 0;
        return `http://127.0.0.1:${port}/a2a`;
      },
    },
    listAgents: () => [
      { name: 'pi', harness: 'pi', model: 'auto/coding', default: true },
      { name: 'smart-codex', harness: 'codex', model: null, default: false },
    ],
  });
  server = await startServeServer(app, '127.0.0.1', 0);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    spool,
    launches,
    close: async () => {
      tasks.dispose();
      await new Promise<void>((resolve, reject) =>
        server!.close(error => (error ? reject(error) : resolve()))
      );
      fs.rmSync(uiDirectory, { recursive: true, force: true });
      fs.rmSync(spool, { recursive: true, force: true });
    },
  };
}

/** An SDK client; `polling: true` because `e` returns the submitted task at once (a run takes minutes). */
function sdkClient(fetchImpl: typeof fetch = fetch) {
  return new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
      clientConfig: { polling: true },
    })
  );
}

const userMessage = (text: string, agent: string) =>
  SendMessageRequest.fromJSON({
    message: {
      messageId: 'sdk-msg-1',
      role: 'ROLE_USER',
      parts: [{ text }],
      metadata: { agent },
    },
  });

test('interop: the SDK client resolves the card, sends a message, follows the task with tasks/get, lists and cancels', async () => {
  const facade = await startFacade();
  try {
    const client = await sdkClient().createFromUrl(facade.baseUrl);
    const card = await client.getAgentCard();
    assert.equal(card.name, 'e');
    assert.deepEqual(
      card.skills.map(skill => skill.id),
      ['pi', 'smart-codex']
    );
    assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
    assert.equal(client.protocolVersion, '1.0');

    const result = await client.sendMessage(
      userMessage('Fix it', 'smart-codex')
    );
    assert.ok('status' in result, 'message/send answers a Task');
    const task = result as Task;
    assert.equal(task.status?.state, TaskState.TASK_STATE_SUBMITTED);
    assert.equal(task.history[0].parts[0].content?.$case, 'text');
    assert.equal(task.metadata?.agent, 'smart-codex');
    assert.deepEqual(facade.launches[0].slice(0, 2), ['spawn', 'smart-codex']);

    writeStatus(facade.spool, 'a2a-001', {
      status: 'running',
      branch: 'e/smart-codex/fix-it-1',
      updatedAt: 't1',
    });
    const working = await client.getTask(
      GetTaskRequest.fromJSON({ id: task.id })
    );
    assert.equal(working.status?.state, TaskState.TASK_STATE_WORKING);
    assert.equal(working.metadata?.branch, 'e/smart-codex/fix-it-1');

    const listed = await client.listTasks(ListTasksRequest.fromJSON({}));
    assert.deepEqual(
      listed.tasks.map(t => t.id),
      [task.id]
    );

    const canceling = await client.cancelTask(
      CancelTaskRequest.fromJSON({ id: task.id })
    );
    assert.equal(canceling.id, task.id);

    // A blocking-mode client (the SDK default) is answered too: the task as
    // submitted, never an error, since e cannot hold a response for a run.
    const blocking = await new ClientFactory().createFromUrl(facade.baseUrl);
    const second = (await blocking.sendMessage(
      userMessage('Another', 'pi')
    )) as Task;
    assert.equal(second.status?.state, TaskState.TASK_STATE_SUBMITTED);
    assert.equal(readRecord(facade.spool, 'a2a-002')?.agent, 'pi');

    // The SDK's own error mapping: an unknown task is TaskNotFound (-32001).
    await assert.rejects(
      client.getTask(GetTaskRequest.fromJSON({ id: 'nope' })),
      (err: unknown) => /-32001|not found|Unknown task/i.test(String(err))
    );
  } finally {
    await facade.close();
  }
});

test('interop: the SDK client streams a task to completion and reads the run artifact', async () => {
  const facade = await startFacade();
  try {
    const client = await sdkClient().createFromUrl(facade.baseUrl);
    const seen: string[] = [];
    let artifact: TaskArtifactUpdateEvent | undefined;
    let final: TaskStatusUpdateEvent | undefined;
    const stream = client.sendMessageStream(userMessage('Fix it', 'pi'));
    for await (const response of stream as AsyncGenerator<StreamResponse>) {
      const payload = response.payload;
      assert.ok(payload);
      seen.push(payload.$case);
      if (payload.$case === 'task') {
        // The run reports as the stream is open: working, then done.
        writeStatus(facade.spool, 'a2a-001', {
          status: 'running',
          branch: 'e/pi/fix-it-1',
          updatedAt: 't1',
        });
        setTimeout(() => {
          writeStatus(facade.spool, 'a2a-001', {
            status: 'done',
            branch: 'e/pi/fix-it-1',
            exitCode: 0,
            pushed: true,
            pullRequestUrl: 'https://example.com/pr/7',
            updatedAt: 't2',
          });
        }, 60);
      }
      if (payload.$case === 'artifactUpdate') artifact = payload.value;
      if (payload.$case === 'statusUpdate') final = payload.value;
    }
    assert.deepEqual(seen, [
      'task',
      'statusUpdate',
      'artifactUpdate',
      'statusUpdate',
    ]);
    assert.equal(final?.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(artifact?.lastChunk, true);
    assert.equal(artifact?.artifact?.name, 'run');
    const data = artifact?.artifact?.parts[0].content;
    assert.equal(data?.$case, 'data');
    assert.deepEqual(data?.$case === 'data' ? data.value : undefined, {
      branch: 'e/pi/fix-it-1',
      exitCode: 0,
      pushed: true,
      pullRequestUrl: 'https://example.com/pr/7',
    });
    const text = artifact?.artifact?.parts[1].content;
    assert.equal(text?.$case, 'text');
    assert.match(
      text?.$case === 'text' ? text.value : '',
      /https:\/\/example\.com\/pr\/7/
    );
  } finally {
    await facade.close();
  }
});

test('interop: the SDK client presents the bearer token the card requires; without it the endpoint refuses', async () => {
  const facade = await startFacade('s3cret');
  try {
    const open = await sdkClient().createFromUrl(facade.baseUrl);
    const card = await open.getAgentCard();
    assert.equal(
      card.securitySchemes.bearer?.scheme?.$case,
      'httpAuthSecurityScheme'
    );
    assert.deepEqual(Object.keys(card.securityRequirements[0].schemes), [
      'bearer',
    ]);
    await assert.rejects(open.listTasks(ListTasksRequest.fromJSON({})));

    const withToken: typeof fetch = (input, init) =>
      fetch(input, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          authorization: 'Bearer s3cret',
        },
      });
    const authed = await sdkClient(withToken).createFromUrl(facade.baseUrl);
    const listed = await authed.listTasks(ListTasksRequest.fromJSON({}));
    assert.deepEqual(listed.tasks, []);
  } finally {
    await facade.close();
  }
});

// --- 2. e's client against the SDK server -----------------------------------

/**
 * A remote agent built on the SDK: echoes the prompt back as an artifact
 * after a `working` step, or, for a prompt saying "wait", stays working until
 * canceled. Statuses are published the way the SDK's own samples do.
 */
class EchoExecutor implements AgentExecutor {
  readonly prompts: string[] = [];
  readonly canceled: string[] = [];
  private readonly waiting = new Map<string, () => void>();

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const part = ctx.userMessage.parts[0]?.content;
    const prompt = part?.$case === 'text' ? part.value : '';
    this.prompts.push(prompt);
    const base = { id: ctx.taskId, contextId: ctx.contextId };
    bus.publish(
      AgentEvent.task(
        Task.fromJSON({
          ...base,
          status: { state: 'TASK_STATE_SUBMITTED' },
          history: [ctx.userMessage],
        })
      )
    );
    bus.publish(
      AgentEvent.statusUpdate(
        TaskStatusUpdateEvent.fromJSON({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          status: { state: 'TASK_STATE_WORKING' },
        })
      )
    );
    if (prompt.includes('wait')) {
      await new Promise<void>(resolve => this.waiting.set(ctx.taskId, resolve));
      bus.finished();
      return;
    }
    bus.publish(
      AgentEvent.artifactUpdate(
        TaskArtifactUpdateEvent.fromJSON({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          artifact: {
            artifactId: 'echo',
            name: 'answer',
            parts: [{ text: `Echo: ${prompt}` }],
          },
          lastChunk: true,
        })
      )
    );
    bus.publish(
      AgentEvent.statusUpdate(
        TaskStatusUpdateEvent.fromJSON({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          status: { state: 'TASK_STATE_COMPLETED' },
        })
      )
    );
    bus.finished();
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    this.canceled.push(taskId);
    bus.publish(
      AgentEvent.statusUpdate(
        TaskStatusUpdateEvent.fromJSON({
          taskId,
          contextId: 'ctx',
          status: { state: 'TASK_STATE_CANCELED' },
        })
      )
    );
    this.waiting.get(taskId)?.();
    this.waiting.delete(taskId);
  }
}

async function startSdkAgent(): Promise<{
  url: string;
  executor: EchoExecutor;
  close: () => Promise<void>;
}> {
  const executor = new EchoExecutor();
  const app = express();
  let server: Server | undefined = undefined;
  const card = () =>
    AgentCard.fromJSON({
      name: 'echo',
      description: 'Echoes the prompt',
      version: '1.0.0',
      supportedInterfaces: [
        {
          url: `http://127.0.0.1:${(server?.address() as { port: number }).port}/a2a`,
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
        },
      ],
      capabilities: { streaming: true },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [
        { id: 'echo', name: 'echo', description: 'Echo', tags: ['test'] },
      ],
    });
  // The handler is built after listen so the card can name the real port.
  let handler: DefaultRequestHandler | undefined = undefined;
  app.use('/.well-known/agent-card.json', (req, res, next) =>
    agentCardHandler({ agentCardProvider: () => handler!.getAgentCard() })(
      req,
      res,
      next
    )
  );
  app.use('/a2a', (req, res, next) =>
    jsonRpcHandler({
      requestHandler: handler!,
      userBuilder: UserBuilder.noAuthentication,
    })(req, res, next)
  );
  server = await new Promise<Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  handler = new DefaultRequestHandler(
    card(),
    new InMemoryTaskStore(),
    executor
  );
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/a2a`,
    executor,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server!.close(error => (error ? reject(error) : resolve()))
      ),
  };
}

test("interop: e's client completes a task against the SDK server and reads its artifact as the answer", async () => {
  const agent = await startSdkAgent();
  try {
    const client = new A2aClient();
    const endpoint = { url: agent.url };
    const sent = await client.sendMessage(endpoint, 'What is X?', {
      source: 'e',
    });
    assert.equal(sent.kind, 'task');
    if (sent.kind !== 'task') throw new Error('unreachable');
    const done = await client.waitForTask(endpoint, sent.task, { pollMs: 5 });
    assert.equal(wireTaskState(done), 'completed');
    assert.equal(taskAnswer(done), 'Echo: What is X?');
    assert.deepEqual(agent.executor.prompts, ['What is X?']);
    // The SDK server writes the 1.0 wire enums e reads.
    assert.equal(
      done.status.state,
      taskStateToJSON(TaskState.TASK_STATE_COMPLETED)
    );
  } finally {
    await agent.close();
  }
});

test("interop: a Store agent with transport a2a on the SDK server, as a top-level spawn and as a sibling; the sibling's kill cancels the remote task", async () => {
  const agent = await startSdkAgent();
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'e-interop-sib-'));
  ensureSpool(spool);
  try {
    const remote: RemoteA2aAgent = {
      name: 'echo',
      transport: 'a2a',
      url: agent.url,
      headers: { 'X-Team': '${TEAM}' },
    };
    const printed: string[] = [];
    const code = await runRemoteAgent({
      agent: remote,
      prompt: 'Summarize the ADRs',
      storeEnv: { TEAM: 'e' },
      pollMs: 5,
      print: text => printed.push(text),
    });
    assert.equal(code, 0);
    assert.deepEqual(printed, ['Echo: Summarize the ADRs']);

    const request = {
      id: 'sib-001',
      agent: 'echo',
      prompt: 'Which X?',
      requestedAt: 't',
    };
    writeRequest(spool, request);
    const sibling = remoteSiblingProcess({
      agent: remote,
      request,
      spoolDir: spool,
      storeEnv: { TEAM: 'e' },
      client: new A2aClient(),
      pollMs: 5,
    });
    assert.equal(await sibling.exited, 0);
    const status = readStatus(spool, 'sib-001');
    assert.equal(status?.status, 'done');
    assert.equal(status?.answer, 'Echo: Which X?');
    assert.equal(readRecord(spool, 'sib-001')?.taskState, 'completed');

    // A sibling the parent cancels: the remote task is canceled over the wire.
    const waiting = {
      id: 'sib-002',
      agent: 'echo',
      prompt: 'please wait',
      requestedAt: 't',
    };
    writeRequest(spool, waiting);
    const canceled = remoteSiblingProcess({
      agent: remote,
      request: waiting,
      spoolDir: spool,
      storeEnv: { TEAM: 'e' },
      client: new A2aClient(),
      pollMs: 5,
    });
    const untilWorking = Date.now() + 5000;
    while (agent.executor.prompts.length < 3 && Date.now() < untilWorking) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    canceled.kill();
    assert.equal(await canceled.exited, 1);
    assert.equal(readStatus(spool, 'sib-002')?.error, 'canceled');
    const untilCanceled = Date.now() + 5000;
    while (agent.executor.canceled.length === 0 && Date.now() < untilCanceled) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(agent.executor.canceled.length, 1);
  } finally {
    await agent.close();
    fs.rmSync(spool, { recursive: true, force: true });
  }
});
