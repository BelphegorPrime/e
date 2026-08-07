/**
 * Pure decisions behind the `spawn` command. The command action stays a thin
 * edge that performs the I/O (filesystem, runtime) and effects (`process.exit`,
 * `console`); the branching logic that decides *what* to do lives here so it can
 * be tested directly, without building an image or running a container.
 */

/**
 * The env files a run loads, in precedence order. `--env-file` entries loaded
 * later override earlier ones for the same key, so the shared base `.e/.env`
 * comes first and the user's `--env-file` second. Absent inputs are dropped;
 * the caller decides presence (the base file must exist on disk, the user file
 * is whatever `--env-file` was given).
 */
export function orderEnvFiles(
  baseEnvPath: string | undefined,
  userEnvFile: string | undefined,
): string[] {
  const files: string[] = [];
  if (baseEnvPath !== undefined) files.push(baseEnvPath);
  if (userEnvFile !== undefined) files.push(userEnvFile);
  return files;
}

/** Inputs to the image-build gate; all pre-resolved by the caller. */
export interface ImageActionInput {
  /** `--rebuild` was passed: always (re)build. */
  rebuild: boolean;
  /** An image with the harness's tag already exists locally. */
  imageExists: boolean;
  /** `e init` has written this harness's Dockerfile under the resolved root. */
  initialized: boolean;
}

/**
 * Decides what a spawn should do about the harness image before running:
 *
 * - `skip` — a usable image is already present and no rebuild was requested.
 * - `build` — an image is needed and the harness is initialized (has a Dockerfile).
 * - `not-initialized` — an image is needed but the harness has no Dockerfile;
 *   the caller surfaces the "run `e init`" error.
 *
 * The caller performs the effect the decision names; this function does no I/O.
 */
export function decideImageAction({
  rebuild,
  imageExists,
  initialized,
}: ImageActionInput): 'skip' | 'build' | 'not-initialized' {
  const needBuild = rebuild || !imageExists;
  if (!needBuild) return 'skip';
  return initialized ? 'build' : 'not-initialized';
}
