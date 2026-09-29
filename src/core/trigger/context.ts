import os from 'os';
import path from 'path';
import { listAgents } from '../agent/agent.js';
import { HARNESSES } from '../harness/index.js';
import type { TriggerContext } from './index.js';

/**
 * What the Store around a trigger knows: the names `agent` may resolve to,
 * and whether this Store sits inside the repository it targets. The home
 * Store is the one case where it does not - `resolveRoot` falls back there
 * exactly when no ancestor had a `.e` - and a trigger there must name its own
 * `repo`.
 */
export function storeTriggerContext(root: string | undefined): TriggerContext {
  // An unresolved root is the home Store by the same rule that resolves it.
  const resolved = path.resolve(root ?? os.homedir());
  return {
    knownAgents: [
      ...listAgents(root).map(agent => agent.name),
      ...Object.keys(HARNESSES),
    ],
    repoLocal: resolved !== path.resolve(os.homedir()),
  };
}
