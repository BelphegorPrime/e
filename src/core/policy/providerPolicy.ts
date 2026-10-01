import { isRemoteAgent, type Agent } from '../agent/agent.js';
import { providerBaseUrl } from '../harness/adapter.js';
import { GLOBAL_BASE_URL_ENV } from '../harness/renderEnvTemplate.js';

/**
 * **The provider policy** (#180, ADR-0019 section 10): where a Store lets
 * its code and prompts go. A run sends the repository and the task to its
 * Agent's provider, and a fusion to every candidate's and the synthesizer's
 * at once, so a Store that keeps a sensitive repository says where they may
 * go - in `config.json`, beside the other host-only settings:
 *
 * ```jsonc
 * "providers": {
 *   "allow": ["*.anthropic.com", "localhost", "harness:claudeCode"],
 *   "deny": ["api.example.com"]
 * }
 * ```
 *
 * - **A destination is a host**, lower-cased, without port, path or a
 *   trailing dot, an IP in its canonical form. An Agent's destinations are
 *   where its run actually sends: a Remote agent's URL; with a provider, the
 *   base URL its harness's config adapter renders (`providerBaseUrl`: the
 *   literal `baseUrl` for Claude Code and Codex, the `baseUrlEnv` value for
 *   pi and opencode); without one, every global base URL
 *   (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`) the container receives from
 *   the Store's `.env`, `--env-file` or `-e`, else `harness:<name>`, the
 *   harness's own default. Every destination of an Agent must pass.
 * - **A pattern** is a host, `*.<domain>` (its subdomains, not the apex),
 *   `harness:<name>`, or `*` (everything).
 * - **Deny wins**; an allow list, when there is one, admits only what it
 *   names. No policy refuses nothing.
 * - **It fails closed.** A malformed policy refuses every run rather than
 *   dropping the rule it could not read, and a destination that does not
 *   resolve (pi's `baseUrlEnv` with no value) is refused under any policy.
 *
 * Pure: the caller resolves the Agents and reads the env, and calls this
 * before any image, worktree or container exists.
 */

/** A Store's policy as `config.json` declares it; `invalid` when it could not be read. */
export interface ProviderPolicy {
  allow?: string[];
  deny?: string[];
  /** Why the declared policy is unusable; every Agent is then refused. */
  invalid?: string;
}

/** The env an Agent's destinations resolve from. */
export interface DestinationEnv {
  /** The Store's `.env`, or what stands in for it: a provider's `baseUrlEnv` resolves here. */
  store: Readonly<Record<string, string>>;
  /** Further layers the container receives (`--env-file`, `-e`): a global base URL may come from them. */
  container?: readonly Readonly<Record<string, string>>[];
}

/** What an Agent is to the run that is checked: in a message, `<role> "<agent>"`. */
export type AgentRole = 'agent' | 'candidate' | 'synthesizer' | 'sibling';

/** One destination the policy refuses, and why. */
export interface ProviderViolation {
  agent: string;
  /** Where it sends; `null` when that does not resolve. */
  destination: string | null;
  why: string;
}

const HARNESS_PREFIX = 'harness:';
const HARNESS = /^harness:[A-Za-z0-9._-]+$/;
const KEYS = ['allow', 'deny'];

/** A URL host as a destination: what `URL` makes of it, without a trailing dot. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '');
}

/** The destination of a URL, or `null` when it is no URL with a host. */
function destinationOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = normalizeHost(new URL(url).hostname);
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/** A pattern, normalized as a destination is, or why it is not one. */
function parsePattern(raw: unknown): string | Error {
  if (typeof raw !== 'string') return new Error('patterns are strings');
  const p = raw.trim();
  if (p === '*') return p;
  if (HARNESS.test(p)) return p.toLowerCase();
  const wildcard = p.startsWith('*.');
  const host = wildcard ? p.slice(2) : p;
  const reason = new Error(
    `"${raw}" is not a host, *.<domain>, harness:<name> or * (no scheme, port or path)`
  );
  if (host === '' || /[/:@?#\s]/.test(host.replace(/^\[.*\]$/, ''))) {
    return reason;
  }
  const parsed = destinationOf(`http://${host}`);
  if (parsed === null) return reason;
  return wildcard ? `*.${parsed}` : parsed;
}

/**
 * The `providers` block of `config.json`: `undefined` when absent, else the
 * normalized lists, or the block with `invalid` set when any part of it
 * cannot be read.
 */
export function parseProviderPolicy(raw: unknown): ProviderPolicy | undefined {
  if (raw === undefined) return undefined;
  const invalid = (why: string): ProviderPolicy => ({ invalid: why });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return invalid('expected { allow?: [...], deny?: [...] }');
  }
  const block = raw as Record<string, unknown>;
  for (const key of Object.keys(block)) {
    if (!KEYS.includes(key)) return invalid(`unknown key "${key}"`);
  }
  const policy: ProviderPolicy = {};
  for (const key of KEYS as ('allow' | 'deny')[]) {
    const list = block[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      return invalid(`"${key}" must be a list of patterns`);
    }
    const patterns: string[] = [];
    for (const entry of list) {
      const pattern = parsePattern(entry);
      if (pattern instanceof Error) {
        return invalid(`${key}: ${pattern.message}`);
      }
      patterns.push(pattern);
    }
    policy[key] = patterns;
  }
  return policy;
}

/**
 * Where an Agent's run sends the repository and the prompt (see the module
 * doc); `null` for a destination that does not resolve.
 */
export function agentDestinations(
  agent: Agent,
  env: DestinationEnv
): (string | null)[] {
  if (isRemoteAgent(agent)) return [destinationOf(agent.url)];
  if (agent.provider) {
    return [
      destinationOf(providerBaseUrl(agent.harness, agent.provider, env.store)),
    ];
  }
  const layers = [env.store, ...(env.container ?? [])];
  const globals = new Set<string | null>();
  for (const layer of layers) {
    for (const name of GLOBAL_BASE_URL_ENV) {
      if (layer[name]) globals.add(destinationOf(layer[name]));
    }
  }
  return globals.size > 0
    ? [...globals]
    : [`${HARNESS_PREFIX}${agent.harness}`];
}

function matches(pattern: string, destination: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith(HARNESS_PREFIX)) {
    return pattern === destination.toLowerCase();
  }
  if (pattern.startsWith('*.')) return destination.endsWith(pattern.slice(1));
  return pattern === destination;
}

/** Why the policy refuses `destination`, or `undefined` when it does not. */
function refusal(
  policy: ProviderPolicy,
  destination: string | null
): string | undefined {
  if (policy.invalid !== undefined) {
    return `the policy is invalid: ${policy.invalid}`;
  }
  if (destination === null) {
    return 'its base URL does not resolve, so where it sends cannot be checked';
  }
  const denied = policy.deny?.find(p => matches(p, destination));
  if (denied !== undefined) return `denied by "${denied}"`;
  if (policy.allow && !policy.allow.some(p => matches(p, destination))) {
    return 'not in the allow list';
  }
  return undefined;
}

/** Every destination of `agents` the policy refuses, in order; none without a policy. */
export function providerPolicyViolations(
  policy: ProviderPolicy | undefined,
  agents: readonly Agent[],
  env: DestinationEnv
): ProviderViolation[] {
  if (!policy) return [];
  const violations: ProviderViolation[] = [];
  for (const agent of agents) {
    for (const destination of agentDestinations(agent, env)) {
      const why = refusal(policy, destination);
      if (why !== undefined) {
        violations.push({ agent: agent.name, destination, why });
      }
    }
  }
  return violations;
}

/**
 * Throws, before anything is built, when the policy refuses any of
 * `agents`: one message naming each refused Agent, every role it fills, and
 * where it sends. `what` names what is refused ("this run", `fusion profile
 * "x"`).
 */
export function assertProviderPolicy(
  policy: ProviderPolicy | undefined,
  agents: readonly { role: AgentRole; agent: Agent }[],
  env: DestinationEnv,
  what: string
): void {
  // One Agent may fill two roles (a candidate that also synthesizes).
  const roles = new Map<string, AgentRole[]>();
  const unique = new Map<string, Agent>();
  for (const { role, agent } of agents) {
    const list = roles.get(agent.name) ?? [];
    if (!list.includes(role)) list.push(role);
    roles.set(agent.name, list);
    unique.set(agent.name, agent);
  }
  const violations = providerPolicyViolations(
    policy,
    [...unique.values()],
    env
  );
  if (violations.length === 0) return;
  const lines = violations.map(
    v =>
      `${roles.get(v.agent)!.join(' and ')} "${v.agent}" sends to ${v.destination ?? 'an unresolved base URL'}: ${v.why}`
  );
  throw new Error(
    `The provider policy in config.json "providers" refuses ${what}:\n  ${lines.join('\n  ')}`
  );
}
