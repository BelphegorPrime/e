import fs from 'node:fs';
import http from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * The slice of the container engine's HTTP API that the browser terminal needs
 * (ADR-0014): find a run's container by name, hijack its TTY stream, resize
 * the TTY. Docker and Podman (`podman system service`) both speak this API over
 * a unix socket; the CLI cannot stand in because `docker attach` refuses to run
 * without a host TTY, and `serve` has none.
 */
export interface EngineApi {
  /** The first running container whose name matches `namePattern` (an engine-side regex). */
  findContainer(namePattern: string): Promise<ContainerRef | undefined>;
  /**
   * Hijacks the container's TTY: the returned stream carries raw terminal
   * bytes both ways (the container was started with `-t`, so the engine does
   * not multiplex stdout/stderr) and ends when the container stops.
   */
  attach(container: string): Promise<Duplex>;
  /** Resizes the container's TTY; a `SIGWINCH` reaches the harness inside. */
  resize(container: string, cols: number, rows: number): Promise<void>;
}

export interface ContainerRef {
  id: string;
  /** The container name without the engine's leading slash. */
  name: string;
}

/**
 * Where the engine listens. `DOCKER_HOST=unix://…` wins, then Docker's default
 * socket, then Podman's rootless service socket. Returns `undefined` when none
 * exists, so `serve` can report "no engine socket" instead of failing on the
 * first attach.
 */
export function resolveEngineSocketPath(
  environment: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = fs.existsSync
): string | undefined {
  const dockerHost = environment.DOCKER_HOST;
  if (dockerHost?.startsWith('unix://')) {
    const path = dockerHost.slice('unix://'.length);
    return exists(path) ? path : undefined;
  }
  const candidates = ['/var/run/docker.sock'];
  const runtimeDir = environment.XDG_RUNTIME_DIR;
  if (runtimeDir) candidates.push(`${runtimeDir}/podman/podman.sock`);
  return candidates.find(exists);
}

/**
 * The container name a run's primary container gets: the run branch
 * `e/<agent>/<slug>-N` with slashes replaced (see `runSpawn`), anchored as an
 * engine-side regex so a slug that merely prefixes another does not match.
 */
export function runContainerPattern(agent: string, slug: string): string {
  const escape = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^/?e-${escape(agent)}-${escape(slug)}-[0-9]+$`;
}

interface ContainerSummary {
  Id: string;
  Names: string[];
}

interface EngineResponse {
  status: number;
  body: string;
}

/** {@link EngineApi} over the engine's unix socket. */
export class UnixSocketEngineApi implements EngineApi {
  constructor(private readonly socketPath: string) {}

  async findContainer(namePattern: string): Promise<ContainerRef | undefined> {
    const filters = encodeURIComponent(JSON.stringify({ name: [namePattern] }));
    const response = await this.request(
      'GET',
      `/containers/json?filters=${filters}`
    );
    if (response.status !== 200) {
      throw new Error(
        `Container engine returned HTTP ${response.status} listing containers`
      );
    }
    const containers = JSON.parse(response.body) as ContainerSummary[];
    // The engine's `name` filter is a substring regex over `/name`; anchoring
    // in the pattern keeps it exact, re-checking here keeps us honest.
    const pattern = new RegExp(namePattern);
    for (const container of containers) {
      const name = container.Names.find(candidate => pattern.test(candidate));
      if (name) return { id: container.Id, name: name.replace(/^\//, '') };
    }
    return undefined;
  }

  attach(container: string): Promise<Duplex> {
    const path = `/containers/${encodeURIComponent(container)}/attach?stream=1&stdin=1&stdout=1&stderr=1&logs=1`;
    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath,
        method: 'POST',
        path,
        headers: {
          'Content-Type': 'application/vnd.docker.raw-stream',
          Connection: 'Upgrade',
          Upgrade: 'tcp',
        },
      });
      request.once('upgrade', (_response, socket, head) => {
        // Output the engine sent along with the 101 belongs to the stream.
        if (head.length > 0) socket.unshift(head);
        resolve(socket);
      });
      request.once('response', response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => (body += chunk));
        response.on('end', () =>
          reject(
            new Error(
              `Container engine refused attach with HTTP ${response.statusCode}: ${body.trim()}`
            )
          )
        );
      });
      request.once('error', reject);
      request.end();
    });
  }

  async resize(container: string, cols: number, rows: number): Promise<void> {
    const response = await this.request(
      'POST',
      `/containers/${encodeURIComponent(container)}/resize?h=${rows}&w=${cols}`
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Container engine returned HTTP ${response.status} resizing the TTY`
      );
    }
  }

  private request(method: string, path: string): Promise<EngineResponse> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { socketPath: this.socketPath, method, path },
        response => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', chunk => (body += chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body })
          );
        }
      );
      request.once('error', reject);
      request.end();
    });
  }
}
