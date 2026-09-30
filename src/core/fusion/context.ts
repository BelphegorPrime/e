import { findAgent, listAgentNames, type Agent } from '../agent/agent.js';
import { HARNESSES } from '../harness/index.js';
import { errorMessage } from '../../shared/utils/errors.js';
import type { FusionContext } from './profile.js';

/**
 * What the Store around a profile knows (ADR-0019 section 2): every name a
 * candidate or synthesizer may be, **resolved** exactly as a spawn resolves
 * it (`findAgent`: the directory name is the identity, the harness must
 * exist), plus every bare harness name. An Agent that does not resolve is
 * kept with its reason rather than thrown, so one broken `agent.json` fails
 * only the profiles that name it.
 */
export function storeFusionContext(root: string | undefined): FusionContext {
  const agents = new Map<string, Agent | Error>();
  for (const name of [...listAgentNames(root), ...Object.keys(HARNESSES)]) {
    if (agents.has(name)) continue;
    try {
      agents.set(name, findAgent(name, root));
    } catch (err) {
      agents.set(name, new Error(errorMessage(err)));
    }
  }
  return { agents };
}
