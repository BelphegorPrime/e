/**
 * **Run egress lockdown** (ADR-0011, attack-surface Zone 1): the allow-list of
 * `host:port` endpoints a run's agent may reach, and the per-host proxy plans
 * that enforce it. Everything here is pure — the spawn plan derives the
 * allow-list from the provider base URL and the selected remote MCP endpoints,
 * and the executor turns it into proxy specs — so the whole decision is
 * testable without a runtime or the network.
 *
 * Mechanism (ADR-0011): the run's private network is created `--internal`, so
 * nothing on it has WAN egress. One proxy container per allow-listed host joins
 * that network (aliased to the endpoint's hostname, listening on the endpoint's
 * port) plus a WAN-capable network (the default bridge, or the compose edge
 * network for `host.docker.internal`), forwarding bytes to the real
 * `host:port`. The agent's URLs are unchanged — its endpoint hostnames resolve
 * to the proxies' run-network IPs, and its only reachable WAN is the allow-list.
 */

import type { Provider } from '../harness/adapter.js';

/**
 * One allow-listed egress destination: a `host` the agent may connect to on
 * `port`. The agent's provider base URL and every remote MCP server URL each
 * contribute one; duplicate `host:port` pairs collapse.
 */
export interface EgressEndpoint {
  host: string;
  port: number;
}

/** Reads an endpoint URL's host and port, applying the scheme default port. */
export function parseEndpointUrl(url: string): EgressEndpoint {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Cannot derive egress endpoint from invalid URL "${url}".`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Cannot allow-list egress for URL "${url}": only http/https URLs are reachable by the agent.`
    );
  }
  if (!parsed.hostname) {
    throw new Error(`Cannot derive egress endpoint from URL "${url}": no host.`);
  }
  const port =
    parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  return { host: parsed.hostname, port };
}

/**
 * The effective base URL of a provider: `baseUrlEnv` (when declared) names an
 * env var in `.e/.env` that overrides the baked `baseUrl` (so the endpoint
 * need not be hard-coded in the Agent). This is the URL the harness will
 * actually talk to, so it is the one the egress allow-list must carry.
 */
export function providerBaseUrl(
  provider: Provider,
  storeEnv: Record<string, string>
): string {
  return provider.baseUrlEnv && storeEnv[provider.baseUrlEnv]
    ? storeEnv[provider.baseUrlEnv]
    : provider.baseUrl;
}

/**
 * Derives the egress allow-list from the URLs the run's agent must reach:
 * the (effective) provider base URL plus every selected remote MCP server URL.
 * Container sidecar endpoints are absent by design — they live on the run's
 * private network already and need no egress. Deduplicated, sorted by host then
 * port, so the plan is deterministic.
 */
export function deriveEgressAllowList(urls: string[]): EgressEndpoint[] {
  const seen = new Map<string, EgressEndpoint>();
  for (const url of urls) {
    const endpoint = parseEndpointUrl(url);
    seen.set(`${endpoint.host}:${endpoint.port}`, endpoint);
  }
  return [...seen.values()].sort(
    (a, b) =>
      a.host.localeCompare(b.host) || a.port - b.port
  );
}

/**
 * One egress proxy to bring up on the run's private network: it listens on the
 * endpoint hostname's ports (the network alias holds the hostname) and forwards
 * to `upstreamHost` on the same ports. `upstreamHost` is either
 * `host.docker.internal` (resolved by the proxy via the compose edge network's
 * DNS) or a public host pinned to an IP at execute time, so the proxy never
 * resolves its own alias. Grouping by host collapses same-host ports into one
 * container: a host with multiple allow-listed ports must resolve to a single
 * listener, because the embedded DNS answers a hostname with one address.
 */
export interface EgressProxyPlan {
  /** Endpoint hostname: the run-network alias the agent resolves. */
  alias: string;
  /** Ports to listen on and forward (the allow-listed ports for this host). */
  ports: number[];
  /** Forward target: `host.docker.internal` or an IP pinned at execute time. */
  upstreamHost: string;
  /**
   * The WAN-capable network the proxy joins beside the run network. The compose
   * edge network when `host` is `host.docker.internal` and the stack is present
   * (its alias resolves the name to OmniRoute itself); the default bridge
   * otherwise.
   */
  wan: string;
  /** Extra `/etc/hosts` mappings (the `host-gateway` mapping for a stack-less `host.docker.internal`). */
  extraHosts?: string[];
}

/** The host whose egress is served by the local compose stack's edge network. */
export const LOCAL_STACK_HOST = 'host.docker.internal';

/**
 * Groups an allow-list into per-host proxy plans, purely. `stackPresent` is the
 * local compose-stack predicate (see `localStack`): when true, a
 * `host.docker.internal` endpoint's proxy joins `omniroute-edge` (where the
 * compose alias resolves the name) instead of the bridge; when false it keeps
 * the historical `host-gateway` mapping, as the agent used to.
 */
export function planEgressProxies(
  allowList: EgressEndpoint[],
  opts: { stackPresent: boolean; edgeNetwork: string }
): EgressProxyPlan[] {
  const byHost = new Map<string, number[]>();
  for (const endpoint of allowList) {
    const ports = byHost.get(endpoint.host) ?? [];
    ports.push(endpoint.port);
    byHost.set(endpoint.host, ports);
  }
  const plans: EgressProxyPlan[] = [];
  for (const [host, ports] of [...byHost.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const local = host === LOCAL_STACK_HOST;
    const plan: EgressProxyPlan = {
      alias: host,
      ports: [...ports].sort((a, b) => a - b),
      upstreamHost: local ? LOCAL_STACK_HOST : host,
      wan: local && opts.stackPresent ? opts.edgeNetwork : 'bridge',
    };
    if (local && !opts.stackPresent) {
      plan.extraHosts = ['host.docker.internal:host-gateway'];
    }
    plans.push(plan);
  }
  return plans;
}

/** The static egress proxy image tag; built once and cached like the mcp sidecars. */
export const EGRESS_IMAGE_TAG = 'e-egress';

/** The env var the proxy image reads for its upstream forward target. */
export const EGRESS_HOST_ENV = 'EGRESS_HOST';
/** The env var the proxy image reads for its (space-separated) listen ports. */
export const EGRESS_PORTS_ENV = 'EGRESS_PORTS';

/**
 * Renders the egress proxy Dockerfile: Alpine plus `socat`, with a CMD that
 * starts one `socat` per allow-listed port, forking connections to
 * `EGRESS_HOST` on the same port. `fork,reuseaddr` keeps concurrent agent
 * connections working, and a trailing `wait` keeps the container alive as long
 * as any listener runs.
 */
export function renderEgressDockerfile(): string {
  return [
    `# Egress proxy (ADR-0011): forwards the run network's allow-listed host:port`,
    `# pairs to the real upstream. Built once, cached as e-egress.`,
    `FROM alpine:3.20`,
    `RUN apk add --no-cache socat`,
    `# One socat per port in ${EGRESS_PORTS_ENV} (space-separated); the listen`,
    `# port equals the upstream port, so the agent's URLs are unchanged.`,
    `CMD ["sh", "-c", "for p in $${EGRESS_PORTS_ENV}; do socat TCP-LISTEN:$p,fork,reuseaddr TCP:$${EGRESS_HOST_ENV}:$p & done; wait"]`,
  ].join('\n') + '\n';
}