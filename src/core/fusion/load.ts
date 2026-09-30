import fs from 'fs';
import type { HarnessAgent } from '../agent/agent.js';
import { fusionConfigPath, fusionsBaseDir } from '../store/paths.js';
import { errorMessage } from '../../shared/utils/errors.js';
import { storeFusionContext } from './context.js';
import {
  FUSION_NAME_PATTERN,
  parseFusionProfile,
  type FusionContext,
  type FusionProfile,
} from './profile.js';

/**
 * Reading the Store's fusion profiles (ADR-0019 section 2). A listing turns a
 * broken profile into an invalid entry, never a throw, as the trigger loader
 * does; {@link findFusionProfile}, the one `e fuse` calls before it spends
 * anything, throws with the reason instead.
 *
 * `root` is the Store root as `findRoot` resolves it (the walk up from the
 * working directory, then home); these functions do not walk themselves.
 */

/** One directory under `fusions/`: either a profile, or why it is not one. */
export interface LoadedFusionProfile {
  /** The directory name, which is the profile's id either way. */
  name: string;
  profile?: FusionProfile;
  error?: string;
}

/** A profile ready to run: every Agent it names, resolved as a spawn resolves it. */
export interface FoundFusionProfile {
  profile: FusionProfile;
  /** One entry per distinct candidate and the synthesizer, all harness agents. */
  agents: ReadonlyMap<string, HarnessAgent>;
}

/** Lists the profile directory names, in directory order. */
export function listFusionProfileNames(root?: string): string[] {
  const dir = fusionsBaseDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

/** Loads one profile directory, turning any failure into a reason. */
export function loadFusionProfile(
  name: string,
  root?: string,
  context: FusionContext = {}
): LoadedFusionProfile {
  // Checked before the name becomes a path: `../agents/x` must not be read.
  if (!FUSION_NAME_PATTERN.test(name)) {
    return {
      name,
      error: `"${name}" is not a fusion profile name (${FUSION_NAME_PATTERN})`,
    };
  }
  const file = fusionConfigPath(name, root);
  if (!fs.existsSync(file)) {
    return { name, error: `no fusion.json in ${name}/` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return {
      name,
      error: `Invalid fusion profile "${name}" at ${file}: ${errorMessage(err)}`,
    };
  }
  try {
    return { name, profile: parseFusionProfile(raw, name, file, context) };
  } catch (err) {
    return { name, error: errorMessage(err) };
  }
}

/** Loads every profile directory in the Store. */
export function loadFusionProfiles(
  root?: string,
  context: FusionContext = {}
): LoadedFusionProfile[] {
  return listFusionProfileNames(root).map(name =>
    loadFusionProfile(name, root, context)
  );
}

/**
 * The profile `name`, validated against the Store it lives in, with every
 * Agent it names resolved - or a throw saying why not. What `e fuse` calls
 * first, so an invalid profile fails before any image, worktree or container
 * exists, and the Agents it hands on are the ones that were checked.
 */
export function findFusionProfile(
  name: string,
  root?: string
): FoundFusionProfile {
  if (
    FUSION_NAME_PATTERN.test(name) &&
    !fs.existsSync(fusionConfigPath(name, root))
  ) {
    const names = listFusionProfileNames(root);
    throw new Error(
      `Unknown fusion profile "${name}". Available: ${names.length ? names.join(', ') : '(none)'}.`
    );
  }
  const context = storeFusionContext(root);
  const loaded = loadFusionProfile(name, root, context);
  if (!loaded.profile) throw new Error(loaded.error);
  const { profile } = loaded;
  const agents = new Map<string, HarnessAgent>();
  for (const agent of [...profile.candidates, profile.synthesizer]) {
    // The parse has refused every name that is not a resolved harness agent.
    agents.set(agent, context.agents!.get(agent) as HarnessAgent);
  }
  return { profile, agents };
}
