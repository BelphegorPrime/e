import fs from 'node:fs';
import { dockerComposePath, envFilePath } from '../store/paths.js';

/**
 * The **local OmniRoute stack**: the composed set of sidecar services under
 * `.e/` (compose.yaml + .env) that e brings up before a spawn. Stack presence is
 * the single predicate every consumer needs - answer it here, once, so
 * `spawn`/`executeSpawn` can never disagree about whether the stack is up.
 */
export interface LocalStack {
  /** The store root the stack lives under. */
  root: string;
  /** Absolute path to `compose.yaml`. */
  composeFile: string;
  /** Absolute path to `.e/.env`, or undefined when it doesn't exist yet. */
  envFile: string | undefined;
  /** True when the compose file exists - the one stack-present predicate. */
  present: boolean;
}

/**
 * Resolves the local stack state for a store root, or undefined when no root
 * is known (a bare run with no `.e` store). `present` is a plain existence
 * check on the compose file; `.env` presence is reported separately so callers
 * can skip the env-file flag without guessing.
 */
export function localStack(root: string | undefined): LocalStack | undefined {
  if (root === undefined) return undefined;
  const composeFile = dockerComposePath(root);
  const envFile = envFilePath(root);
  return {
    root,
    composeFile,
    envFile: fs.existsSync(envFile) ? envFile : undefined,
    present: fs.existsSync(composeFile),
  };
}
