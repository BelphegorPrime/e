import fs from 'fs';
import { HARNESSES } from './harness/index';
import { agentFilePath, agentsBaseDir } from './store';

/**
 * An **Agent**: a named pairing of a Harness with a Tier (and, in later slices,
 * a Provider). It is the selectable unit a Run executes. In this slice an Agent
 * carries only a harness reference and a tier — no custom provider and no
 * derived image; a default agent runs its harness's base image exactly as
 * before. See ADR-0004.
 */
export interface Agent {
  /** Registry key and branch segment, e.g. "smart-codex". */
  name: string;
  /** Name of the Harness this agent runs. */
  harness: string;
  /** Capability/cost class, e.g. "default", "smart", "cheap". */
  tier: string;
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
        `Agent under "${name}" declares a different name "${onDisk.name}"; the directory name is the agent's identity.`,
      );
    }
    if (!deps.harnesses.includes(onDisk.harness)) {
      throw new Error(
        `Agent "${name}" references unknown harness "${onDisk.harness}". Valid harnesses: ${deps.harnesses.join(', ')}.`,
      );
    }
    return onDisk;
  }

  if (deps.harnesses.includes(name)) {
    return { name, harness: name, tier: 'default' };
  }

  const agentList = deps.agents.length ? deps.agents.join(', ') : '(none)';
  throw new Error(
    `Unknown agent or harness "${name}". Available agents: ${agentList}. Harnesses: ${deps.harnesses.join(', ')}.`,
  );
}

/** The JSON content of a harness's default agent definition, used by `e init`. */
export function renderDefaultAgent(harnessName: string): string {
  const agent: Agent = { name: harnessName, harness: harnessName, tier: 'default' };
  return JSON.stringify(agent, null, 2) + '\n';
}

/** Parses a persisted `agent.json`, or returns undefined if it isn't there. */
function readAgentFile(name: string, root?: string): Agent | undefined {
  const file = agentFilePath(name, root);
  if (!fs.existsSync(file)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Agent>;
  if (
    typeof parsed.name !== 'string' ||
    typeof parsed.harness !== 'string' ||
    typeof parsed.tier !== 'string'
  ) {
    throw new Error(
      `Invalid agent definition at ${file}: expected { name, harness, tier } strings.`,
    );
  }
  return { name: parsed.name, harness: parsed.harness, tier: parsed.tier };
}

/** Lists the persisted agent names under the store's `agents/` directory. */
function listAgentNames(root?: string): string[] {
  const dir = agentsBaseDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Resolves a spawn target against the real store on disk: wires the persisted
 * `agent.json` reader, the harness registry, and the agent-name listing into
 * the pure {@link resolveAgent}.
 */
export function findAgent(name: string, root?: string): Agent {
  return resolveAgent(name, {
    readAgent: (n) => readAgentFile(n, root),
    harnesses: Object.keys(HARNESSES),
    agents: listAgentNames(root),
  });
}
