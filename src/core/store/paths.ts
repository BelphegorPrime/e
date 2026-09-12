import path from 'path';

/**
 * The Store's **layout**: the `.e` directory holding e's on-disk state - the
 * per-harness Dockerfiles under `harnesses/`, the Agent definitions under
 * `agents/`, the container MCP server definitions under `mcp/`, the Skills
 * under `skills/`, and the shared `.env` base environment. This leaf owns path
 * derivation keyed on a harness, agent, MCP-server, or skill *name*. It knows
 * nothing about the Harness, Agent, MCP, or Skill registries, so the dependency
 * runs one way: `harness`/`agent`/`mcp`/`skill` → `store`.
 */

/**
 * The `.e` directory under `root` that holds all of e's state (harness
 * Dockerfiles, the shared `.env`, ...).
 * `root` defaults to the current directory; `e init --dir <path>` uses
 * `<path>` as the root instead (e.g. to init into the current project).
 */
export function eBaseDir(root: string = process.cwd()): string {
  return path.join(root, '.e');
}

/** Base directory that holds the harness Dockerfiles, under `root`. */
export function harnessesBaseDir(root?: string): string {
  return path.join(eBaseDir(root), 'harnesses');
}

/** Base directory that holds the Agent definitions, under `root`. */
export function agentsBaseDir(root?: string): string {
  return path.join(eBaseDir(root), 'agents');
}

/** Base directory that holds the container MCP server definitions, under `root`. */
export function mcpBaseDir(root?: string): string {
  return path.join(eBaseDir(root), 'mcp');
}

/** Base directory that holds the Skill definitions, under `root`. */
export function skillsBaseDir(root?: string): string {
  return path.join(eBaseDir(root), 'skills');
}

/** Directory containing a single Skill's files (`SKILL.md` + optional resources). */
export function skillDir(name: string, root?: string): string {
  return path.join(skillsBaseDir(root), name);
}

/** Absolute path to a Skill's `SKILL.md` manifest - the file that makes a dir a skill. */
export function skillManifestPath(name: string, root?: string): string {
  return path.join(skillDir(name, root), 'SKILL.md');
}

/** Directory containing a single MCP server's definition (Dockerfile + mcp.json). */
export function mcpDir(name: string, root?: string): string {
  return path.join(mcpBaseDir(root), name);
}

/** Absolute path to an MCP server's `mcp.json` metadata file. */
export function mcpConfigPath(name: string, root?: string): string {
  return path.join(mcpDir(name, root), 'mcp.json');
}

/** Directory containing a single agent's definition. */
export function agentDir(name: string, root?: string): string {
  return path.join(agentsBaseDir(root), name);
}

/** Absolute path to an agent's definition file. */
export function agentFilePath(name: string, root?: string): string {
  return path.join(agentDir(name, root), 'agent.json');
}

/**
 * Path to the shared `.env` file loaded as the base environment for every
 * harness container. Lives alongside the `harnesses/` dir under `.e`.
 */
export function envFilePath(root?: string): string {
  return path.join(eBaseDir(root), '.env');
}

/** Absolute path to the Store's Docker Compose file written by `e init`. */
export function dockerComposePath(root?: string): string {
  return path.join(eBaseDir(root), 'compose.yaml');
}

/** Absolute path to the generated Compose bootstrap script written by `e init`. */
export function bootstrapScriptPath(root?: string): string {
  return path.join(eBaseDir(root), 'bootstrap.sh');
}

/**
 * Path to the host-only `config.json`. Unlike `.env`, this file holds
 * orchestration settings for the host and is **never injected into a
 * container** - nothing in the spawn path passes it as environment.
 */
export function configFilePath(root?: string): string {
  return path.join(eBaseDir(root), 'config.json');
}

/** Absolute path to the host-only model registry (`model-ids.json`). */
export function modelsFilePath(root?: string): string {
  return path.join(eBaseDir(root), 'model-ids.json');
}

/** Directory containing a single harness's Dockerfile. */
export function harnessDir(name: string, root?: string): string {
  return path.join(harnessesBaseDir(root), name);
}

/** Absolute path to a harness's Dockerfile. */
export function dockerfilePath(name: string, root?: string): string {
  return path.join(harnessDir(name, root), 'Dockerfile');
}

/** Directory holding the shared egress container's build context (`Dockerfile` + entrypoint). */
export function egressDir(root?: string): string {
  return path.join(eBaseDir(root), 'egress');
}

/** Directory holding the runtime-broker's build context (`Dockerfile` + bundled server, ADR-0013). */
export function brokerDir(root?: string): string {
  return path.join(eBaseDir(root), 'broker');
}

/** Absolute path to the store's egress blacklist file (host-editable, never clobbered). */
export function egressBlacklistPath(root?: string): string {
  return path.join(eBaseDir(root), 'egress-blacklist');
}

/** Absolute path to the store's egress iptables rules script (host-editable, never clobbered). */
export function egressIptablesPath(root?: string): string {
  return path.join(eBaseDir(root), 'egress-iptables.rules');
}
