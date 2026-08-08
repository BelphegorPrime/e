import fs from 'fs';
import { mcpConfigPath, mcpBaseDir } from '../store';

/**
 * The **MCP server** context (ADR-0005): a capability the agent connects to over
 * the Model Context Protocol, chosen per-Run with `--mcp <name>`. A
 * `container`-transport server is built from its own Dockerfile under the Store's
 * `mcp/<name>/` and run as a **Sidecar** on the Run's private network, exposing
 * **streamable HTTP** (the intersection of what the MCP clients accept — see
 * `docs/research/harness-cli-facts.md`).
 *
 * The parse/derive/render helpers (`parseMcpServer`, the name/tag/endpoint
 * derivations, the shipped-server renderers) are pure. `readMcpServer` and
 * `listMcpServerNames` are the thin `fs` edge over them; the spawn edge performs
 * the remaining effects (building images, starting sidecars). This module
 * imports paths *from* `store`, never the reverse.
 */

/**
 * A container MCP server, as declared in `.e/mcp/<name>/mcp.json`. Only the
 * `container` transport exists today (a `remote` URL server needs no sidecar and
 * is a future slice).
 */
export interface McpServer {
  /** Registry key = directory name = the alias the agent reaches on the network. */
  name: string;
  /** The only transport today: built from a Dockerfile and run as a sidecar. */
  transport: 'container';
  /** TCP port the server listens on; the readiness probe and the agent both use it. */
  port: number;
  /**
   * Env vars the *sidecar* needs (e.g. an API token) — delivered to the sidecar
   * at runtime from `.e/.env`, never to the agent. Empty for a credential-free
   * server.
   */
  requiredEnv: string[];
  /**
   * Optional in-container readiness command (run via `<runtime> exec`); readiness
   * requires it to exit 0 on top of the TCP port being open. Absent → TCP only.
   */
  healthcheck?: string[];
}

/**
 * Validates a parsed `mcp.json` object into an {@link McpServer}, purely. `name`
 * is the directory name (the server's identity), so it is supplied by the caller,
 * not read from the file. `where` names the source in error messages.
 */
export function parseMcpServer(raw: unknown, name: string, where: string): McpServer {
  const p = (raw ?? {}) as Partial<McpServer> & Record<string, unknown>;

  if (p.transport !== 'container') {
    throw new Error(
      `Invalid MCP server "${name}" at ${where}: transport must be "container" ` +
        `(got ${JSON.stringify(p.transport)}). Only container-transport servers run as sidecars today.`,
    );
  }
  if (typeof p.port !== 'number' || !Number.isInteger(p.port) || p.port <= 0) {
    throw new Error(
      `Invalid MCP server "${name}" at ${where}: "port" must be a positive integer.`,
    );
  }
  const requiredEnv = p.requiredEnv ?? [];
  if (!isStringArray(requiredEnv)) {
    throw new Error(
      `Invalid MCP server "${name}" at ${where}: "requiredEnv" must be an array of strings.`,
    );
  }
  const server: McpServer = { name, transport: 'container', port: p.port, requiredEnv };

  if (p.healthcheck !== undefined) {
    if (!isStringArray(p.healthcheck) || p.healthcheck.length === 0) {
      throw new Error(
        `Invalid MCP server "${name}" at ${where}: "healthcheck" must be a non-empty array of strings.`,
      );
    }
    server.healthcheck = p.healthcheck;
  }
  return server;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Reads and parses a persisted MCP server by name, or undefined if it isn't there. */
export function readMcpServer(name: string, root?: string): McpServer | undefined {
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
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * The image tag for an MCP server's sidecar. Namespaced `e-mcp-*`, distinct from
 * the `e-harness-*` and `e-agent-*` tags so a sidecar image never collides with a
 * harness or agent image.
 */
export function sidecarImageTag(name: string): string {
  return `e-mcp-${name}`;
}

/**
 * The private per-run network name. Derived from the run name (already unique per
 * run — see `runSpawn`), so two concurrent runs never share a network.
 */
export function sidecarNetworkName(runName: string): string {
  return `${runName}-net`;
}

/**
 * The sidecar's container name — unique per run so concurrent runs of the same
 * MCP server never collide. The agent still reaches the server at its short
 * `name` via a network alias (see the spawn edge), so the URL host stays stable.
 */
export function sidecarContainerName(runName: string, mcpName: string): string {
  return `${runName}-mcp-${mcpName}`;
}

/** The endpoint an agent connects an MCP client to: the server's short alias and its URL. */
export interface McpEndpoint {
  /** The server's short name / network alias (the URL host). */
  name: string;
  /** The streamable-HTTP URL, e.g. `http://everything:3001/mcp`. */
  url: string;
}

/** The endpoint the agent connects to: the server's short alias, its port, and the streamable-HTTP `/mcp` path. */
export function mcpEndpoint(server: McpServer): McpEndpoint {
  return { name: server.name, url: `http://${server.name}:${server.port}/mcp` };
}

/** The rendered files for a shipped MCP server: its Dockerfile and mcp.json. */
export type McpServerFiles = { Dockerfile: string; 'mcp.json': string };

function mcpJson(server: Omit<McpServer, 'name'>): string {
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
    'mcp.json': mcpJson({ transport: 'container', port: 3001, requiredEnv: [] }),
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
    'mcp.json': mcpJson({ transport: 'container', port: 8000, requiredEnv: [] }),
  };
}

/** The MCP servers `e init` ships, keyed by name. */
export const SHIPPED_MCP_SERVERS: Record<string, () => McpServerFiles> = {
  everything: renderEverythingFiles,
  filesystem: renderFilesystemFiles,
};
