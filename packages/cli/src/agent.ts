import fs from 'fs';
import { HARNESSES } from './harness/index';
import { PROTOCOLS, type Provider, type Protocol } from './harness/adapter';
import { agentFilePath, agentsBaseDir } from './store';

/**
 * An **Agent**: a named pairing of a Harness with, optionally, an inline
 * {@link Provider}. It is the selectable unit a Run executes. An Agent without
 * a provider runs its harness's base image against the ambient env exactly as
 * before; an Agent with a provider has that provider rendered into the
 * harness's native config form by the harness adapter. See ADR-0004/0006.
 */
export interface Agent {
  /** Registry key and branch segment, e.g. "smart-codex". */
  name: string;
  /** Name of the Harness this agent runs. */
  harness: string;
  /** Inline model endpoint; absent for a default agent (behaves as before). */
  provider?: Provider;
  /**
   * Default Skills baked into this agent's image (ADR-0006 layer 2). Each names a
   * skill under the Store's `skills/`; a Run may add more per-run with `--skill`.
   * Absent or empty for an agent with no baked skills.
   */
  skills?: string[];
}

/** Inputs to the pure agent resolution; the glue supplies the real values. */
export interface ResolveAgentDeps {
  /** Loads a persisted agent definition by name, or undefined if none exists. */
  readAgent: (name: string) => Agent | undefined;
  /** Valid harness names. */
  harnesses: string[];
  /** Available (persisted) agent names, used only for the not-found message. */
  agents: string[];
}

/**
 * Resolves a spawn target to an Agent, purely:
 *  1. A persisted agent by that name wins (its harness reference is validated).
 *  2. Otherwise a bare harness name derives that harness's default agent.
 *  3. Otherwise it is an error listing the available agents and harnesses.
 */
export function resolveAgent(name: string, deps: ResolveAgentDeps): Agent {
  const onDisk = deps.readAgent(name);
  if (onDisk) {
    if (onDisk.name !== name) {
      throw new Error(
        `Agent under "${name}" declares a different name "${onDisk.name}"; the directory name is the agent's identity.`
      );
    }
    if (!deps.harnesses.includes(onDisk.harness)) {
      throw new Error(
        `Agent "${name}" references unknown harness "${onDisk.harness}". Valid harnesses: ${deps.harnesses.join(', ')}.`
      );
    }
    return onDisk;
  }

  if (deps.harnesses.includes(name)) {
    return { name, harness: name };
  }

  const agentList = deps.agents.length ? deps.agents.join(', ') : '(none)';
  throw new Error(
    `Unknown agent or harness "${name}". Available agents: ${agentList}. Harnesses: ${deps.harnesses.join(', ')}.`
  );
}

/** The JSON content of a harness's default agent definition, used by `e init`. */
export function renderDefaultAgent(
  harnessName: string,
  envValues: Record<string, string>
): string {
  const harness = HARNESSES[harnessName];

  const agent: Agent = {
    name: harnessName,
    harness: harnessName,
    provider: {
      baseUrl:
        envValues['OPENAI_BASE_URL'] || 'http://host.docker.internal:20128/v1',
      baseUrlEnv: 'OPENAI_BASE_URL',
      model: 'auto',
      protocol: harness.protocols[0],
      apiKeyEnv: 'OPENAI_API_KEY',
    },
  };

  return JSON.stringify(agent, null, 2) + '\n';
}

/** Parses a persisted `agent.json`, or returns undefined if it isn't there. */
function readAgentFile(name: string, root?: string): Agent | undefined {
  const file = agentFilePath(name, root);
  if (!fs.existsSync(file)) return undefined;
  return parseAgent(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}

/**
 * Validates a parsed `agent.json` object into an {@link Agent}, purely. The
 * `name`/`harness` strings are required; a `provider`, if present, is validated
 * in shape (its protocol must be one `e` recognises — whether the harness
 * *speaks* it is checked later, against the resolved harness). `where` names
 * the source in error messages.
 */
export function parseAgent(raw: unknown, where: string): Agent {
  const parsed = (raw ?? {}) as Partial<Agent>;
  if (typeof parsed.name !== 'string' || typeof parsed.harness !== 'string') {
    throw new Error(
      `Invalid agent definition at ${where}: expected { name, harness } strings.`
    );
  }
  const agent: Agent = {
    name: parsed.name,
    harness: parsed.harness,
  };
  if (parsed.provider !== undefined) {
    agent.provider = parseProvider(parsed.provider, where);
  }
  if (parsed.skills !== undefined) {
    if (
      !Array.isArray(parsed.skills) ||
      !parsed.skills.every(s => typeof s === 'string')
    ) {
      throw new Error(
        `Invalid agent definition at ${where}: "skills" must be an array of strings.`
      );
    }
    if (parsed.skills.length > 0) agent.skills = parsed.skills;
  }
  return agent;
}

/** Validates a parsed `provider` block into a {@link Provider}, purely. */
function parseProvider(raw: unknown, where: string): Provider {
  const p = (raw ?? {}) as Partial<Provider>;
  if (
    typeof p.baseUrl !== 'string' ||
    typeof p.model !== 'string' ||
    typeof p.protocol !== 'string' ||
    typeof p.apiKeyEnv !== 'string'
  ) {
    throw new Error(
      `Invalid provider in agent definition at ${where}: expected { baseUrl, model, protocol, apiKeyEnv } strings.`
    );
  }
  if (!PROTOCOLS.includes(p.protocol as Protocol)) {
    throw new Error(
      `Invalid provider protocol "${p.protocol}" in agent definition at ${where}. Valid protocols: ${PROTOCOLS.join(', ')}.`
    );
  }

  const provider: Provider = {
    baseUrl: p.baseUrl,
    baseUrlEnv: p.baseUrlEnv,
    model: p.model,
    protocol: p.protocol as Protocol,
    apiKeyEnv: p.apiKeyEnv,
  };

  return provider;
}

/** Lists the persisted agent names under the store's `agents/` directory. */
function listAgentNames(root?: string): string[] {
  const dir = agentsBaseDir(root);

  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

/** Reads and parses every persisted agent under the store's `agents/` directory. */
export function listAgents(root?: string): Agent[] {
  const agentNames = listAgentNames(root);
  return agentNames
    .map(name => readAgentFile(name, root))
    .filter((agent): agent is Agent => agent !== undefined);
}

/**
 * Resolves a spawn target against the real store on disk: wires the persisted
 * `agent.json` reader, the harness registry, and the agent-name listing into
 * the pure {@link resolveAgent}.
 */
export function findAgent(name: string, root?: string): Agent {
  return resolveAgent(name, {
    readAgent: n => readAgentFile(n, root),
    harnesses: Object.keys(HARNESSES),
    agents: listAgentNames(root),
  });
}

/**
 * True if `name` names a persisted agent or a known harness — used to tell a
 * spawn *target* from a bare *prompt*. This is a lightweight existence check;
 * {@link findAgent} still performs the full validation once a target is chosen.
 */
export function isKnownTarget(name: string, root?: string): boolean {
  return (
    Object.keys(HARNESSES).includes(name) || listAgentNames(root).includes(name)
  );
}
