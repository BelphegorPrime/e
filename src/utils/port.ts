/**
 * Port availability helpers for local listeners (`serve`, embed proxies).
 *
 * Availability is established the only reliable way: by binding. A port is
 * "in use" when the bind fails with `EADDRINUSE` (or `EACCES`, which is what
 * a privileged port looks like to an unprivileged process); anything else is
 * a real error and propagates. The probe listener is closed before resolving,
 * so a small race with another process remains possible - callers still have
 * to handle a failing `listen`, this only makes the common case pleasant.
 */
import net from 'node:net';

const IN_USE_CODES = new Set(['EADDRINUSE', 'EACCES']);

/** How many ports above the requested one `resolveFreePort` tries before
 *  asking the OS for an ephemeral port. */
export const DEFAULT_PORT_SCAN_RANGE = 100;

export interface FreePortOptions {
  /** Interface to bind when probing. Defaults to loopback. */
  host?: string;
  /** Number of consecutive ports above `port` to try before falling back
   *  to an OS-assigned ephemeral port. `0` skips the scan. */
  scanRange?: number;
}

/**
 * Tries to bind `port` on `host`; resolves with the port actually bound
 * (which matters for `port === 0`) or `null` when the port is in use.
 */
async function tryBind(port: number, host: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code && IN_USE_CODES.has(error.code)) resolve(null);
      else reject(error);
    });
    server.listen(port, host, () => {
      const address = server.address();
      const bound =
        typeof address === 'object' && address ? address.port : port;
      server.close(() => resolve(bound));
    });
  });
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError(`Invalid port: ${port}`);
  }
}

/** Whether something is already listening on `host:port`. */
export async function isPortInUse(
  port: number,
  host = '127.0.0.1'
): Promise<boolean> {
  assertValidPort(port);
  return (await tryBind(port, host)) === null;
}

/**
 * Returns `port` when it is free. Otherwise returns the nearest free port
 * above it (within `scanRange`), and as a last resort an OS-assigned
 * ephemeral port - so the result is always a port that was bindable a
 * moment ago.
 */
export async function resolveFreePort(
  port: number,
  {
    host = '127.0.0.1',
    scanRange = DEFAULT_PORT_SCAN_RANGE,
  }: FreePortOptions = {}
): Promise<number> {
  assertValidPort(port);
  const last = Math.min(port + scanRange, 65535);
  for (let candidate = port; candidate <= last; candidate++) {
    const bound = await tryBind(candidate, host);
    if (bound !== null) return bound;
  }
  const ephemeral = await tryBind(0, host);
  if (ephemeral === null) {
    throw new Error(`No free port available on ${host}`);
  }
  return ephemeral;
}

/** True when `port .. port + count - 1` are all free on `host`. */
async function isBlockFree(
  port: number,
  count: number,
  host: string
): Promise<boolean> {
  if (port + count - 1 > 65535) return false;
  for (let offset = 0; offset < count; offset++) {
    if ((await tryBind(port + offset, host)) === null) return false;
  }
  return true;
}

/** Ephemeral draws `resolveFreePortBlock` makes before giving up. */
const EPHEMERAL_BLOCK_ATTEMPTS = 20;

/**
 * Like `resolveFreePort`, but for `count` consecutive ports that must all be
 * free together - for listeners that derive their port from a sibling (the
 * OmniRoute embed proxy sits at BFF port + 1). Returns the first port of the
 * block: `port` itself when the whole block is free, otherwise the nearest
 * start above it within `scanRange`, and as a last resort a block anchored at
 * an OS-assigned ephemeral port. Throws when no block can be found.
 */
export async function resolveFreePortBlock(
  port: number,
  count: number,
  {
    host = '127.0.0.1',
    scanRange = DEFAULT_PORT_SCAN_RANGE,
  }: FreePortOptions = {}
): Promise<number> {
  assertValidPort(port);
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`Invalid port block size: ${count}`);
  }
  const last = Math.min(port + scanRange, 65535);
  for (let candidate = port; candidate <= last; candidate++) {
    if (await isBlockFree(candidate, count, host)) return candidate;
  }
  for (let attempt = 0; attempt < EPHEMERAL_BLOCK_ATTEMPTS; attempt++) {
    const start = await tryBind(0, host);
    if (start !== null && (await isBlockFree(start, count, host))) return start;
  }
  throw new Error(`No block of ${count} free ports available on ${host}`);
}
