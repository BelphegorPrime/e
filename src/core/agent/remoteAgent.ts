/**
 * A **remote A2A agent** in the Store (ADR-0015): an `agent.json` with
 * `"transport": "a2a"` names an agent hosted elsewhere that speaks the
 * Agent2Agent protocol. It has no harness, no image and no worktree: `e`
 * sends it a prompt as an A2A message and takes its artifacts as the answer.
 * The mirror image of a `remote` MCP server (`mcp/index.ts`): selected by
 * name like any agent, wired by URL, credentials referenced as `${VAR}` and
 * resolved from `.e/.env` on the host at call time - never stored in the
 * definition, never baked.
 */

/** The shape of an `agent.json` with `transport: "a2a"`. */
export interface RemoteA2aAgent {
  /** Registry key = directory name. */
  name: string;
  transport: 'a2a';
  /** The agent's JSON-RPC endpoint (the `url` of its agent card's JSON-RPC interface). */
  url: string;
  /** Optional request headers, e.g. `{ Authorization: 'Bearer ${REMOTE_TOKEN}' }`; values may reference `${VAR}`. */
  headers?: Record<string, string>;
  /** The env vars the headers reference, resolved from `.e/.env` on the host; empty for an open endpoint. */
  requiredEnv?: string[];
  /** A line for the agent card and the UI: what this agent is good for. */
  description?: string;
}

/** True for a parsed `agent.json` object that declares the A2A transport. */
export function declaresA2aTransport(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as Record<string, unknown>).transport === 'a2a'
  );
}

/**
 * Validates a parsed `agent.json` with `transport: "a2a"` into a
 * {@link RemoteA2aAgent}, purely. `where` names the source in error messages.
 */
export function parseRemoteA2aAgent(
  raw: unknown,
  where: string
): RemoteA2aAgent {
  const p = (raw ?? {}) as Record<string, unknown>;
  if (typeof p.name !== 'string' || p.name === '') {
    throw new Error(
      `Invalid agent definition at ${where}: a remote A2A agent needs a "name".`
    );
  }
  if (typeof p.url !== 'string' || !/^https?:\/\//.test(p.url)) {
    throw new Error(
      `Invalid agent definition at ${where}: a remote A2A agent needs an http(s) "url".`
    );
  }
  const agent: RemoteA2aAgent = { name: p.name, transport: 'a2a', url: p.url };
  if (p.headers !== undefined) {
    if (
      typeof p.headers !== 'object' ||
      p.headers === null ||
      Array.isArray(p.headers) ||
      !Object.values(p.headers).every(v => typeof v === 'string')
    ) {
      throw new Error(
        `Invalid agent definition at ${where}: "headers" must be an object of string values.`
      );
    }
    agent.headers = p.headers as Record<string, string>;
  }
  if (p.requiredEnv !== undefined) {
    if (
      !Array.isArray(p.requiredEnv) ||
      !p.requiredEnv.every(v => typeof v === 'string')
    ) {
      throw new Error(
        `Invalid agent definition at ${where}: "requiredEnv" must be an array of strings.`
      );
    }
    agent.requiredEnv = p.requiredEnv as string[];
  }
  if (p.description !== undefined) {
    if (typeof p.description !== 'string') {
      throw new Error(
        `Invalid agent definition at ${where}: "description" must be a string.`
      );
    }
    agent.description = p.description;
  }
  return agent;
}

/**
 * Expands `${VAR}` references in `value` from `env`, purely. A reference to a
 * variable that is not set is an error naming it - a header sent with a hole
 * in it would only fail later, at the remote end, without saying why.
 */
export function expandEnvRefs(
  value: string,
  env: Record<string, string | undefined>,
  where: string
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    const resolved = env[name];
    if (resolved === undefined || resolved === '') {
      throw new Error(
        `${where} references \${${name}}, which is not set in .e/.env.`
      );
    }
    return resolved;
  });
}

/** The agent's headers with every `${VAR}` resolved from `env`. */
export function resolveRemoteHeaders(
  agent: RemoteA2aAgent,
  env: Record<string, string | undefined>
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(agent.headers ?? {})) {
    headers[name] = expandEnvRefs(
      value,
      env,
      `Header "${name}" of remote agent "${agent.name}"`
    );
  }
  return headers;
}
