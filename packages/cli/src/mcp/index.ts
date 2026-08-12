import fs from 'fs';
import { mcpConfigPath, mcpBaseDir } from '../store';

/**
 * The **MCP server** context (ADR-0005/0006): a capability the agent connects to
 * over the Model Context Protocol, chosen per-Run with `--mcp <name>`. Its
 * `mcp.json` `transport` decides the mechanism, while selection is uniform (by
 * name):
 *  - `container` — built from a Dockerfile under `mcp/<name>/` and run as a
 *    **Sidecar** on the Run's private network, exposing streamable HTTP.
 *  - `remote` — an already-hosted URL, wired to the agent's MCP client directly;
 *    no sidecar, no network entry. Auth headers may reference `${VAR}` env vars,
 *    resolved by the harness at runtime from `.e/.env` (never baked, never argv).
 *
 * The parse/derive/render helpers (`parseMcpServer`, the name/tag/endpoint
 * derivations, `planMcpSelection`, the shipped-server renderers) are pure.
 * `readMcpServer` and `listMcpServerNames` are the thin `fs` edge over them; the
 * spawn edge performs the remaining effects (building images, starting sidecars,
 * rendering credential env-files). This module imports paths *from* `store`,
 * never the reverse. Grounding: `docs/research/harness-cli-facts.md`.
 */

/** Fields every MCP server shares, regardless of transport. */
interface McpServerBase {
  /** Registry key = directory name = the alias the agent reaches it by. */
  name: string;
  /**
   * Env vars this server's wiring needs, resolved from `.e/.env` at runtime and
   * never baked. For a `container` server they are delivered to the *sidecar*;
   * for a `remote` server they are delivered to the *agent* (its MCP client
   * expands `${VAR}` in the url/headers). Empty for a credential-free server.
   */
  requiredEnv: string[];
}

/** A container MCP server: built from a Dockerfile and run as a per-run sidecar. */
export interface ContainerMcpServer extends McpServerBase {
  transport: 'container';
  /** TCP port the server listens on; the readiness probe and the agent both use it. */
  port: number;
  /**
   * Optional in-container readiness command (run via `<runtime> exec`); readiness
   * requires it to exit 0 on top of the TCP port being open. Absent → TCP only.
   */
  healthcheck?: string[];
}

/** A remote MCP server: an already-hosted URL wired straight to the agent's client. */
export interface RemoteMcpServer extends McpServerBase {
  transport: 'remote';
  /** The hosted streamable-HTTP URL; may contain `${VAR}` references (ADR-0006). */
  url: string;
  /**
   * Optional request headers for auth, e.g. `{ Authorization: 'Bearer ${TOKEN}' }`.
   * Values may reference `${VAR}`; the harness resolves them from the process env
   * at runtime (Claude Code expands `${VAR}` in `--mcp-config` values).
   */
  headers?: Record<string, string>;
}

/**
 * An MCP server, as declared in `.e/mcp/<name>/mcp.json`. The `transport`
 * discriminates the mechanism; both kinds are selected the same way, by name.
 */
export type McpServer = ContainerMcpServer | RemoteMcpServer;

/**
 * Validates a parsed `mcp.json` object into an {@link McpServer}, purely. `name`
 * is the directory name (the server's identity), so it is supplied by the caller,
 * not read from the file. `where` names the source in error messages.
 */
export function parseMcpServer(
  raw: unknown,
  name: string,
  where: string
): McpServer {
  const p = (raw ?? {}) as Record<string, unknown>;

  const requiredEnv = p.requiredEnv ?? [];
  if (!isStringArray(requiredEnv)) {
    throw new Error(
      `Invalid MCP server "${name}" at ${where}: "requiredEnv" must be an array of strings.`
    );
  }

  if (p.transport === 'container') {
    if (
      typeof p.port !== 'number' ||
      !Number.isInteger(p.port) ||
      p.port <= 0
    ) {
      throw new Error(
        `Invalid MCP server "${name}" at ${where}: "port" must be a positive integer.`
      );
    }
    const server: ContainerMcpServer = {
      name,
      transport: 'container',
      port: p.port,
      requiredEnv,
    };
    if (p.healthcheck !== undefined) {
      if (!isStringArray(p.healthcheck) || p.healthcheck.length === 0) {
        throw new Error(
          `Invalid MCP server "${name}" at ${where}: "healthcheck" must be a non-empty array of strings.`
        );
      }
      server.healthcheck = p.healthcheck;
    }
    return server;
  }

  if (p.transport === 'remote') {
    if (typeof p.url !== 'string' || p.url === '') {
      throw new Error(
        `Invalid MCP server "${name}" at ${where}: a remote server needs a non-empty "url".`
      );
    }
    const server: RemoteMcpServer = {
      name,
      transport: 'remote',
      url: p.url,
      requiredEnv,
    };
    if (p.headers !== undefined) {
      if (!isStringRecord(p.headers)) {
        throw new Error(
          `Invalid MCP server "${name}" at ${where}: "headers" must be an object of string values.`
        );
      }
      server.headers = p.headers;
    }
    return server;
  }

  throw new Error(
    `Invalid MCP server "${name}" at ${where}: transport must be "container" or "remote" ` +
      `(got ${JSON.stringify(p.transport)}).`
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(v => typeof v === 'string')
  );
}

/** Reads and parses a persisted MCP server by name, or undefined if it isn't there. */
export function readMcpServer(
  name: string,
  root?: string
): McpServer | undefined {
  const file = mcpConfigPath(name, root);
  if (!fs.existsSync(file)) return undefined;
  return parseMcpServer(JSON.parse(fs.readFileSync(file, 'utf8')), name, file);
}

/** Lists the persisted MCP server names under the store's `mcp/` directory. */
export function listMcpServerNames(root?: string): string[] {
  const dir = mcpBaseDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

/** The endpoint an agent connects an MCP client to: the server's name and its URL. */
export interface McpEndpoint {
  /** The server's short name (config key / network alias). */
  name: string;
  /** The streamable-HTTP URL — a per-run sidecar alias, or a remote server's hosted URL. */
  url: string;
  /** Optional auth headers (remote only); values may contain `${VAR}` for runtime expansion. */
  headers?: Record<string, string>;
}

/**
 * The endpoint the agent connects to. A container server is reached at its
 * per-run network alias (`http://<name>:<port>/mcp`); a remote server is reached
 * at its declared URL, carrying any auth headers.
 */
export function mcpEndpoint(server: McpServer): McpEndpoint {
  if (server.transport === 'remote') {
    const endpoint: McpEndpoint = { name: server.name, url: server.url };
    if (server.headers) endpoint.headers = server.headers;
    return endpoint;
  }
  return { name: server.name, url: `http://${server.name}:${server.port}/mcp` };
}

/**
 * Splits selected servers by transport and builds every endpoint, purely — the
 * one place the container/remote fork is decided. Container servers become
 * sidecars; remote servers are wired straight to the agent; both contribute an
 * endpoint. Selection order is preserved.
 */
export function planMcpSelection(servers: McpServer[]): {
  containerServers: ContainerMcpServer[];
  remoteServers: RemoteMcpServer[];
  endpoints: McpEndpoint[];
} {
  const containerServers: ContainerMcpServer[] = [];
  const remoteServers: RemoteMcpServer[] = [];
  for (const server of servers) {
    if (server.transport === 'container') containerServers.push(server);
    else remoteServers.push(server);
  }
  return {
    containerServers,
    remoteServers,
    endpoints: servers.map(mcpEndpoint),
  };
}

/** The rendered files for a shipped MCP server: its Dockerfile and mcp.json. */
export type McpServerFiles = { Dockerfile: string; 'mcp.json': string };

function mcpJson(server: Omit<ContainerMcpServer, 'name'>): string {
  return JSON.stringify(server, null, 2) + '\n';
}

/**
 * The reference `everything` server (`@modelcontextprotocol/server-everything`),
 * run in its native streamable-HTTP mode on port 3001 at `/mcp`. Credential-free,
 * needs no stdio→HTTP bridge — the shipped example that proves the whole sidecar
 * path right after `e init`. Grounding: `docs/research/harness-cli-facts.md`.
 */
export function renderEverythingFiles(): McpServerFiles {
  return {
    Dockerfile:
      [
        `# Container MCP server: MCP reference "everything" server, streamable HTTP.`,
        `FROM node:lts-alpine`,
        `RUN npm install -g @modelcontextprotocol/server-everything`,
        `EXPOSE 3001`,
        `# Serves streamable HTTP on PORT (default 3001) at /mcp.`,
        `CMD ["mcp-server-everything", "streamableHttp"]`,
      ].join('\n') + '\n',
    'mcp.json': mcpJson({
      transport: 'container',
      port: 3001,
      requiredEnv: [],
    }),
  };
}

/**
 * A `filesystem` server: the stdio-only `@modelcontextprotocol/server-filesystem`
 * wrapped with `supergateway` to expose streamable HTTP on port 8000 at `/mcp`
 * (ADR-0006's stdio→HTTP bridge made concrete). It serves the sidecar's own
 * `/data` directory — an illustrative, self-contained example, not the agent's
 * workspace.
 */
export function renderFilesystemFiles(): McpServerFiles {
  return {
    Dockerfile:
      [
        `# Container MCP server: filesystem (stdio) bridged to streamable HTTP via supergateway.`,
        `FROM node:lts-alpine`,
        `RUN npm install -g supergateway @modelcontextprotocol/server-filesystem`,
        `RUN mkdir -p /data`,
        `EXPOSE 8000`,
        `# supergateway bridges the stdio server to streamable HTTP on /mcp.`,
        `CMD ["supergateway", "--stdio", "mcp-server-filesystem /data", "--outputTransport", "streamableHttp", "--port", "8000"]`,
      ].join('\n') + '\n',
    'mcp.json': mcpJson({
      transport: 'container',
      port: 8000,
      requiredEnv: [],
    }),
  };
}

/** The MCP servers `e init` ships, keyed by name. */
export const SHIPPED_MCP_SERVERS: Record<string, () => McpServerFiles> = {
  everything: renderEverythingFiles,
  filesystem: renderFilesystemFiles,
};
