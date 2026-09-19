import type { ContainerRunner, RunOptions } from '../../ports/runtime/index.js';
import type { VerifyConfig } from '../../core/store/config.js';
import { errorMessage } from '../../shared/utils/errors.js';

/**
 * The **verify gate** (ADR-0016): the repository's own check, run as a second
 * container against the run's worktree once the run's work is committed. Its
 * exit code is the run's verdict - not the harness's, which says only that the
 * process finished. Not run on the host (an arbitrary repo's test command is
 * exactly what the container boundary exists to contain) and not by the
 * harness (that lets the thing being judged file its own report).
 */

/** What the gate needs to start a container. */
export interface VerifyDeps {
  runtime: ContainerRunner;
}

/** One verify pass against one worktree. */
export interface VerifyParams {
  /** The Store's resolved declaration. */
  verify: VerifyConfig;
  /** Host path of the run's worktree, mounted at `/workspace`. */
  worktreePath: string;
  /** The run's harness image - the default when the declaration names none. */
  harnessImage: string;
  /** Container name for the check, derived from the run. */
  containerName: string;
  /**
   * The run's own egress containment (ADR-0011), which the check joins unless
   * the declaration sets `network: false`: the shared namespace it shares with
   * the agent, or the private networks it was attached to. The check installs
   * its own dependencies, so it needs the network by construction - and it
   * reaches it exactly the way the run does, never more freely.
   */
  netns?: string;
  networks?: readonly string[];
  /**
   * The Store's package-cache volume, mounted at `/cache` when the declaration
   * opts in. Named by the caller, where Store identity already lives; without
   * a name there is nothing to share and the opt-in mounts nothing. Two
   * concurrent runs share it, which npm tolerates and pip may not.
   */
  cacheVolume?: string;
}

/**
 * The verdict, divided on **whose fault it could be**: a failing check is the
 * agent's to fix (red), a check that never ran is not (broken).
 */
export type VerifyOutcome = {
  /** The check's combined, interleaved output - what the next attempt is told. */
  output: string;
} & (
  | { verdict: 'green'; exitCode: number }
  | { verdict: 'red'; exitCode: number; reason: 'exit' | 'timeout' }
  | { verdict: 'broken'; exitCode: number; reason: string }
);

/**
 * Exit codes that mean the check never ran, so the failure cannot be the
 * agent's: iterating against them would burn the whole budget to learn
 * nothing. Documented caveat: a test runner that legitimately exits 127 is
 * misread as a broken check. Loudly wrong beats silently looping.
 */
/** Where the Store's package cache is mounted inside the check's container. */
const CACHE_MOUNT = '/cache';

/**
 * What points the common package managers at {@link CACHE_MOUNT}. A mount
 * nothing reads is decoration. These are host-generated settings, never
 * anything of the run's: a check that could reach the model could buy its way
 * to green, so {@link VerifyParams} carries no environment at all.
 */
function cacheEnv(): string[] {
  return [
    `npm_config_cache=${CACHE_MOUNT}/npm`,
    `PIP_CACHE_DIR=${CACHE_MOUNT}/pip`,
    `YARN_CACHE_FOLDER=${CACHE_MOUNT}/yarn`,
  ];
}

/**
 * The exit code a timed-out check reports. The container was killed before it
 * said anything, so this is `e`'s statement and not the check's: 124 is the
 * `timeout(1)` convention, and `reason` is what separates it from a check that
 * genuinely exited 124.
 */
const VERIFY_TIMEOUT_EXIT_CODE = 124;

const BROKEN_EXIT_CODES: Record<number, string> = {
  125: 'the container could not be created (image missing, or a runtime error)',
  126: 'the command could not be invoked',
  127: 'command not found',
};

/** Runs the declared check against the worktree and returns its verdict. */
export async function runVerify(
  deps: VerifyDeps,
  params: VerifyParams
): Promise<VerifyOutcome> {
  // `network: false` is the only way out; absent means yes, because the check
  // installs its own dependencies.
  const networked = params.verify.network !== false;
  const cached = params.verify.cache === true && !!params.cacheVolume;
  if (cached) deps.runtime.createVolume(params.cacheVolume!);
  const options: RunOptions = {
    name: params.containerName,
    rm: true,
    workdir: '/workspace',
    volumes: [
      { host: params.worktreePath, container: '/workspace' },
      ...(cached
        ? [{ host: params.cacheVolume!, container: CACHE_MOUNT }]
        : []),
    ],
    ...(cached ? { env: cacheEnv() } : {}),
    ...(networked && params.netns ? { netns: params.netns } : {}),
    ...(networked && params.networks?.length
      ? { networks: [...params.networks] }
      : {}),
  };
  const { timeoutMs } = params.verify;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let exitCode: number;
  let output: string;
  try {
    const running = deps.runtime.runCaptured(
      params.verify.image ?? params.harnessImage,
      options,
      ['sh', '-c', params.verify.command]
    );
    const result =
      timeoutMs === undefined
        ? await running
        : await new Promise<{ exitCode: number; output: string }>(
            (resolve, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                // The container is all that still holds the check; removing it
                // is what makes `running` settle in production.
                deps.runtime.removeContainer(params.containerName);
                resolve({ exitCode: VERIFY_TIMEOUT_EXIT_CODE, output: '' });
              }, timeoutMs);
              // Attaching handlers here also means a rejection arriving after
              // the timeout is handled rather than unhandled.
              running.then(resolve, reject);
            }
          );
    exitCode = result.exitCode;
    output = result.output;
  } catch (err) {
    // The port rejects only when the engine itself will not start, which is
    // as far from the agent's fault as a failure gets.
    return {
      verdict: 'broken',
      exitCode: 1,
      reason: errorMessage(err),
      output: '',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (timedOut) {
    return {
      verdict: 'red',
      exitCode: VERIFY_TIMEOUT_EXIT_CODE,
      reason: 'timeout',
      output,
    };
  }
  if (exitCode === 0) return { verdict: 'green', exitCode, output };
  const broken = BROKEN_EXIT_CODES[exitCode];
  if (broken) return { verdict: 'broken', exitCode, reason: broken, output };
  return { verdict: 'red', exitCode, reason: 'exit', output };
}
