/**
 * The Agent2Agent (A2A) protocol on the wire (ADR-0015): the JSON shapes of
 * the 1.0 JSON-RPC binding that `e` speaks - as a **server** (the facade on
 * `e serve`) and as a **client** (a Store agent with `transport: "a2a"`).
 * Only the subset `e` uses is typed; unknown fields pass through untouched.
 *
 * A2A 1.0 writes enums the protobuf way (`TASK_STATE_WORKING`, `ROLE_USER`),
 * puts a Part's content directly under `text` / `data` / `url` / `raw`, and
 * wraps streaming results by type (`{ task }`, `{ statusUpdate }`, ...). The
 * 0.x line wrote `working`, `user` and `kind` discriminators; the readers
 * here accept both, the writers emit 1.0.
 */

import type { TaskState } from '../broker/types.js';

/** The protocol version `e` speaks and advertises. */
export const A2A_PROTOCOL_VERSION = '1.0';

/** The HTTP header (and query parameter) naming the protocol version. */
export const A2A_VERSION_HEADER = 'A2A-Version';

/** The well-known path of an agent card (A2A 1.0). */
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';

/**
 * The JSON-RPC methods of A2A 1.0 that `e` answers: the RPC names of the
 * protocol's service (`SendMessage`, `GetTask`, ...). The 0.x binding used
 * slash names (`message/send`, `tasks/get`); the server still takes those
 * as aliases ({@link LEGACY_A2A_METHODS}), the client sends 1.0 names.
 */
export const A2A_METHODS = {
  sendMessage: 'SendMessage',
  streamMessage: 'SendStreamingMessage',
  getTask: 'GetTask',
  listTasks: 'ListTasks',
  cancelTask: 'CancelTask',
  subscribeTask: 'SubscribeToTask',
  getExtendedAgentCard: 'GetExtendedAgentCard',
} as const;

/** The 1.0 push-notification methods, all refused by `e` with the protocol's own error. */
export const A2A_PUSH_METHODS: readonly string[] = [
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
];

/** 0.x method names → their 1.0 names, accepted by the server for older clients. */
export const LEGACY_A2A_METHODS: Readonly<Record<string, string>> = {
  'message/send': A2A_METHODS.sendMessage,
  'message/stream': A2A_METHODS.streamMessage,
  'tasks/get': A2A_METHODS.getTask,
  'tasks/list': A2A_METHODS.listTasks,
  'tasks/cancel': A2A_METHODS.cancelTask,
  'tasks/resubscribe': A2A_METHODS.subscribeTask,
  'tasks/subscribe': A2A_METHODS.subscribeTask,
  'agent/getAuthenticatedExtendedCard': A2A_METHODS.getExtendedAgentCard,
  'agent/getExtendedCard': A2A_METHODS.getExtendedAgentCard,
  'tasks/pushNotificationConfig/set': 'CreateTaskPushNotificationConfig',
  'tasks/pushNotificationConfig/get': 'GetTaskPushNotificationConfig',
  'tasks/pushNotificationConfig/list': 'ListTaskPushNotificationConfigs',
  'tasks/pushNotificationConfig/delete': 'DeleteTaskPushNotificationConfig',
};

/** The 1.0 name of a method: itself, or the 1.0 name behind a 0.x alias. */
export function canonicalMethod(method: string): string {
  return LEGACY_A2A_METHODS[method] ?? method;
}

/** A2A's own JSON-RPC error codes (spec section on error handling). */
export const A2A_ERROR_CODES = {
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotificationNotSupported: -32003,
  unsupportedOperation: -32004,
  contentTypeNotSupported: -32005,
  invalidAgentResponse: -32006,
  extendedAgentCardNotConfigured: -32007,
  extensionSupportRequired: -32008,
  versionNotSupported: -32009,
} as const;

/** Standard JSON-RPC 2.0 error codes. */
export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/** `e`'s task state → the A2A 1.0 wire value. */
const WIRE_STATE: Record<TaskState, string> = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  'input-required': 'TASK_STATE_INPUT_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  canceled: 'TASK_STATE_CANCELED',
  failed: 'TASK_STATE_FAILED',
  rejected: 'TASK_STATE_REJECTED',
};

export function toWireState(state: TaskState): string {
  return WIRE_STATE[state];
}

/**
 * A wire value → `e`'s task state, tolerant of the 1.0 (`TASK_STATE_X`) and
 * 0.x (`x`, `input-required`) spellings; `auth-required` and unknown values
 * read as `working` (the task is not over) and `unknown` as undefined.
 */
export function fromWireState(value: unknown): TaskState | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .replace(/^TASK_STATE_/, '')
    .toLowerCase()
    .replace(/_/g, '-');
  switch (normalized) {
    case 'submitted':
    case 'working':
    case 'input-required':
    case 'completed':
    case 'canceled':
    case 'failed':
    case 'rejected':
      return normalized;
    case 'cancelled':
      return 'canceled';
    case 'auth-required':
      return 'working';
    case 'unspecified':
    case 'unknown':
      return undefined;
    default:
      return 'working';
  }
}

export type WireRole = 'ROLE_USER' | 'ROLE_AGENT';

/** A message part: exactly one of `text`, `data`, `url` or `raw` is set. */
export interface WirePart {
  text?: string;
  data?: Record<string, unknown>;
  url?: string;
  raw?: string;
  filename?: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
  /** 0.x discriminator, read but never written. */
  kind?: string;
  /** 0.x file part, read but never written. */
  file?: { uri?: string; bytes?: string; name?: string; mimeType?: string };
}

export interface WireMessage {
  messageId: string;
  role: WireRole | string;
  parts: WirePart[];
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

export interface WireTaskStatus {
  state: string;
  /** ISO timestamp of the transition. */
  timestamp?: string;
  /** The agent's word on the transition (why it failed, what input it needs). */
  message?: WireMessage;
}

export interface WireArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: WirePart[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

export interface WireTask {
  id: string;
  contextId: string;
  status: WireTaskStatus;
  artifacts?: WireArtifact[];
  history?: WireMessage[];
  metadata?: Record<string, unknown>;
  /** 0.x discriminator, read but never written. */
  kind?: 'task';
}

export interface WireTaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: WireTaskStatus;
  /** Set on the last event of a stream. */
  final?: boolean;
  metadata?: Record<string, unknown>;
}

export interface WireTaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: WireArtifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

/** One `message/stream` result: A2A 1.0 wraps the payload by type. */
export type WireStreamResult =
  | { task: WireTask }
  | { message: WireMessage }
  | { statusUpdate: WireTaskStatusUpdateEvent }
  | { artifactUpdate: WireTaskArtifactUpdateEvent };

/** `message/send` params. */
export interface WireSendMessageParams {
  message: WireMessage;
  configuration?: {
    acceptedOutputModes?: string[];
    historyLength?: number;
    returnImmediately?: boolean;
    taskPushNotificationConfig?: unknown;
  };
  metadata?: Record<string, unknown>;
  tenant?: string;
}

export interface WireAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface WireAgentInterface {
  url: string;
  protocolBinding: 'JSONRPC' | 'GRPC' | 'HTTP+JSON';
  protocolVersion: string;
}

export interface WireAgentCard {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: WireAgentInterface[];
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    extendedAgentCard: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: WireAgentSkill[];
  /**
   * A2A 1.0 (proto JSON): each scheme is a one-field object naming its kind
   * (`httpAuthSecurityScheme`, `apiKeySecurityScheme`, ...). The 0.x line
   * used a `type` discriminator (`{ type: 'http', scheme: 'bearer' }`).
   */
  securitySchemes?: Record<string, WireSecurityScheme>;
  /** A2A 1.0: which schemes a call needs (`{ schemes: { bearer: { list: [] } } }`); 0.x called it `security`. */
  securityRequirements?: WireSecurityRequirement[];
  provider?: { organization: string; url: string };
  documentationUrl?: string;
}

/** One security scheme, A2A 1.0 shape; only the HTTP kind is written by `e`. */
export interface WireSecurityScheme {
  httpAuthSecurityScheme?: {
    scheme: string;
    description?: string;
    bearerFormat?: string;
  };
  apiKeySecurityScheme?: {
    name: string;
    location: string;
    description?: string;
  };
}

/** A security requirement, A2A 1.0 shape: scheme name → the scopes it needs. */
export interface WireSecurityRequirement {
  schemes: Record<string, { list: string[] }>;
}

/** The text of every text part, joined by blank lines; empty when there is none. */
export function partsText(parts: readonly WirePart[] | undefined): string {
  return (parts ?? [])
    .map(part => (typeof part.text === 'string' ? part.text : ''))
    .filter(text => text !== '')
    .join('\n\n');
}

/** A text part (1.0 shape). */
export function textPart(text: string): WirePart {
  return { text };
}

/** A structured-data part (1.0 shape). */
export function dataPart(data: Record<string, unknown>): WirePart {
  return { data, mediaType: 'application/json' };
}

/** The wire `Task` (or `{task}` wrapper) a `message/send` / `tasks/get` result carries, or undefined. */
export function taskFromResult(result: unknown): WireTask | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const record = result as Record<string, unknown>;
  const candidate =
    'task' in record && typeof record.task === 'object' && record.task !== null
      ? (record.task as Record<string, unknown>)
      : record;
  if (typeof candidate.id !== 'string') return undefined;
  if (typeof candidate.status !== 'object' || candidate.status === null) {
    return undefined;
  }
  return candidate as unknown as WireTask;
}
