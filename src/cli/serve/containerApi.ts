import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
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
 * The local socket a `DOCKER_HOST`/`CONTAINER_HOST` value names, or undefined
 * when the value is not a local socket (`tcp://`, `ssh://`): `unix://<path>`
 * on Linux/macOS, `npipe:////./pipe/<name>` on Windows (returned in the
 * `\\.\pipe\<name>` form Node's `socketPath` takes).
 */
export function localSocketFromHost(host: string): string | undefined {
  if (host.startsWith('unix://')) return host.slice('unix://'.length);
  if (host.startsWith('npipe://')) {
    return host.slice('npipe://'.length).replace(/\//g, '\\');
  }
  return undefined;
}

/**
 * The engine sockets worth probing on `platform`, most common first. Every
 * engine `e` drives exposes the Docker Engine API on one of these: on Linux
 * the system socket, the rootless Docker and Podman user sockets, and the
 * Podman system service; on macOS the per-user sockets Docker Desktop,
 * OrbStack, Colima, Rancher Desktop, and Podman machine create (all under the
 * home directory, so they are independent of `sudo`); on Windows the named
 * pipes of Docker Desktop and Podman machine. Unix paths are built with the
 * POSIX joiner so the list is stable whatever platform computes it.
 */
export function engineSocketCandidates(
  platform: string,
  homedir: string,
  environment: Record<string, string | undefined>
): string[] {
  const join = path.posix.join;
  if (platform === 'win32') {
    return [
      '\\\\.\\pipe\\docker_engine',
      '\\\\.\\pipe\\podman-machine-default',
    ];
  }
  if (platform === 'darwin') {
    return [
      join(homedir, '.docker', 'run', 'docker.sock'),
      '/var/run/docker.sock',
      join(homedir, '.orbstack', 'run', 'docker.sock'),
      join(homedir, '.colima', 'default', 'docker.sock'),
      join(homedir, '.colima', 'docker.sock'),
      join(homedir, '.rd', 'docker.sock'),
      join(
        homedir,
        '.local',
        'share',
        'containers',
        'podman',
        'machine',
        'podman.sock'
      ),
    ];
  }
  const candidates = ['/var/run/docker.sock'];
  const runtimeDir = environment.XDG_RUNTIME_DIR;
  if (runtimeDir) {
    candidates.push(
      join(runtimeDir, 'docker.sock'),
      join(runtimeDir, 'podman', 'podman.sock')
    );
  }
  candidates.push('/run/podman/podman.sock');
  return candidates;
}

/**
 * Where the engine listens. An explicit `DOCKER_HOST` (Docker) or
 * `CONTAINER_HOST` (Podman) naming a local socket wins and is final - a
 * missing socket there yields `undefined` rather than a silent fallback to a
 * different engine. Otherwise the platform's candidates
 * ({@link engineSocketCandidates}) are probed in order. Returns `undefined`
 * when none exists, so `serve` can report "no engine socket" instead of
 * failing on the first attach.
 */
export function resolveEngineSocketPath(
  environment: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = fs.existsSync,
  platform: string = process.platform,
  homedir: string = os.homedir()
): string | undefined {
  for (const key of ['DOCKER_HOST', 'CONTAINER_HOST']) {
    const host = environment[key];
    if (!host) continue;
    const socket = localSocketFromHost(host);
    if (socket !== undefined) return exists(socket) ? socket : undefined;
  }
  return engineSocketCandidates(platform, homedir, environment).find(exists);
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

/**
 * {@link EngineApi} over the engine's local socket: a unix socket on Linux and
 * macOS, or a named pipe (`\\.\pipe\docker_engine`) on Windows - Node's
 * `socketPath` speaks both, so one client covers every platform.
 */
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
