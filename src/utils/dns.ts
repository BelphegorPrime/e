import { promises as dns } from 'dns';

/**
 * Resolves `host` to an IPv4 address, or undefined when it cannot be resolved.
 * Used to pin an egress proxy's public upstream to an IP at spawn time
 * (ADR-0011), so the proxy never resolves its own run-network alias.
 * `host.docker.internal` is a compose-edge DNS name, not a resolvable public
 * host, and never reaches here.
 */
export async function resolveHostIp4(
  host: string
): Promise<string | undefined> {
  try {
    const addresses = await dns.resolve4(host);
    return addresses[0];
  } catch {
    return undefined;
  }
}
