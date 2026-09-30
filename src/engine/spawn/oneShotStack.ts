/**
 * One-shot on a host whose local stack is already running (ADR-0016 section
 * 13, #200): the stack is **used, never started**, and a provider that
 * targets OmniRoute gets **one endpoint key per run**.
 *
 * The stack counts as present when `e-egress` and `omniroute` are running -
 * their names are fixed per host, so it is whichever Store started them.
 * `composeUp` is never called: it would run a Compose file from base or,
 * worse, from the head. With the stack, the run joins `e-egress`'s network
 * namespace exactly as a manual run does, which is what `localStackPresent`
 * decides downstream.
 *
 * The key is minted with `OMNIROUTE_INITIAL_PASSWORD` from `--env-file`
 * (one-shot's only secret source), handed to the run through `storeEnv`
 * and never persisted into a Store, and deleted by {@link PreparedOneShot.release}
 * after teardown. It expires on its own shortly after the run cap, and the
 * next start sweeps leftovers a SIGKILL, host crash or job timeout left
 * behind, so a key an agent leaks is dead once its run is. The password
 * stays host-side: it is not on the plan's whitelist, so it never reaches a
 * container. Nothing here prompts; a trigger has nobody to ask.
 */

import type { ContainerRunner } from '../../ports/runtime/index.js';
import { DEFAULT_LOOP_CAPS } from '../../core/store/config.js';
import {
  EGRESS_CONTAINER,
  OMNIROUTE_CONTAINER,
} from '../../shared/constants.js';
import { env } from '../../shared/utils/env.js';
import { errorMessage } from '../../shared/utils/errors.js';
import { log } from '../../shared/utils/log.js';
import type { SpawnFacts } from './spawnPlan.js';
import { newUlid } from '../queue/runsSpool.js';
import {
  LocalApiKeyError,
  RUN_KEY_PREFIX,
  deleteLocalApiKey,
  listLocalApiKeys,
  mintLocalApiKey,
  providerTargetsLocalStack,
  signInLocalStack,
  staleRunKeys,
  type LocalStackSession,
} from './localApiKey.js';

/**
 * How long a run key outlives the run cap. The key is minted before the
 * images are built, which every spawn does and the cap does not count, so
 * the margin covers a cold build and teardown, never a second run.
 */
export const RUN_KEY_EXPIRY_MARGIN_MS = 60 * 60 * 1000;

export interface OneShotStackDeps {
  /** The resolved container runtime; only `isRunning` is used. */
  runtime: Pick<ContainerRunner, 'isRunning'>;
  /** Override the global `fetch`, so a test can script OmniRoute's answers. */
  fetchImpl?: typeof fetch;
  /** Now, for the key's expiry and the sweep. */
  now?: () => Date;
  /** A fresh unique id for the key's name; a ULID by default. */
  newId?: () => string;
}

/** The facts the plan is built from, and what gives the run's key back. */
export interface PreparedOneShot {
  facts: SpawnFacts;
  /**
   * Deletes the run's key, if one was minted. Call it after teardown, on
   * every way out; it never throws, and a second call does nothing.
   */
  release: () => Promise<void>;
}

/** The release of a run that minted no key. */
export const NOTHING_TO_RELEASE = async (): Promise<void> => undefined;

/** OmniRoute's limit on a key's name. */
const KEY_NAME_MAX = 200;

/**
 * The run key's name: `e-run-`, the run, and something unique to this one,
 * so two runs of one trigger, or several siblings of one agent, can be told
 * apart in OmniRoute's key list. A sibling names its parent run's branch and
 * its sibling id; any other run its `--name` (a trigger's id) or its agent,
 * and `id`. The prefix is what the sweep selects on, so it always survives
 * the length limit, as does the unique tail.
 */
export function runKeyName(facts: SpawnFacts, id: string): string {
  const [run, tail] = facts.sibling
    ? [facts.sibling.parent.branch, facts.sibling.id]
    : [facts.name ?? facts.agent.name, id];
  const room = KEY_NAME_MAX - RUN_KEY_PREFIX.length - tail.length - 1;
  return `${RUN_KEY_PREFIX}${run.slice(0, Math.max(0, room))}-${tail}`;
}

/** Whether this host's local stack is up: both fixed-name containers running. */
export function oneShotStackRunning(
  runtime: Pick<ContainerRunner, 'isRunning'>
): boolean {
  return (
    runtime.isRunning(EGRESS_CONTAINER) &&
    runtime.isRunning(OMNIROUTE_CONTAINER)
  );
}

/** Runs an OmniRoute call, turning a gateway that does not answer into a clear error. */
async function reach<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof LocalApiKeyError) throw error;
    throw new LocalApiKeyError(
      `OmniRoute is not reachable at ${env.omniRoutedUrl}: ${errorMessage(error)}`
    );
  }
}

/** Deletes leftover run keys; a sweep that fails only warns, the mint decides the run. */
async function sweep(
  session: LocalStackSession,
  now: Date,
  capMs: number
): Promise<void> {
  try {
    const stale = staleRunKeys(await listLocalApiKeys(session), now, capMs);
    for (const key of stale) {
      await deleteLocalApiKey(session, key.id);
      log.debug(`Swept the leftover OmniRoute key ${key.name} (${key.id})`);
    }
  } catch (error) {
    log.warn(
      `Could not sweep leftover OmniRoute run keys: ${errorMessage(error)}`
    );
  }
}

/**
 * Detects a running stack and, when the agent's provider targets it, mints
 * the run's key. Returns the facts to plan from: `localStackPresent` set to
 * what is running, and the provider's `apiKeyEnv` holding the run's key.
 * Throws when a key is needed and cannot be had - no password, a rejected
 * one, a gateway that does not answer - so the run exits 1 before a
 * container exists.
 */
export async function prepareOneShotStack(
  facts: SpawnFacts,
  deps: OneShotStackDeps
): Promise<PreparedOneShot> {
  if (!oneShotStackRunning(deps.runtime)) {
    return {
      facts: { ...facts, localStackPresent: false },
      release: NOTHING_TO_RELEASE,
    };
  }
  const withStack: SpawnFacts = { ...facts, localStackPresent: true };
  const provider = facts.agent.provider;
  if (!provider || !providerTargetsLocalStack(provider)) {
    return { facts: withStack, release: NOTHING_TO_RELEASE };
  }

  const password = facts.storeEnv.OMNIROUTE_INITIAL_PASSWORD ?? '';
  if (password === '') {
    const where =
      facts.storeEnvFile !== undefined
        ? `add OMNIROUTE_INITIAL_PASSWORD to ${facts.storeEnvFile}`
        : 'pass --env-file with OMNIROUTE_INITIAL_PASSWORD';
    throw new Error(
      `The local stack is running and agent "${facts.agent.name}" uses its OmniRoute, so this run mints its own endpoint key: ${where} (the stack's dashboard password; it stays on the host).`
    );
  }

  const now = (deps.now ?? (() => new Date()))();
  const capMs = (facts.loop ?? DEFAULT_LOOP_CAPS).totalTimeoutMs;
  const name = runKeyName(facts, (deps.newId ?? newUlid)());
  const session = await reach(() =>
    signInLocalStack({
      baseUrl: env.omniRoutedUrl,
      password,
      fetchImpl: deps.fetchImpl,
    })
  );
  await sweep(session, now, capMs);
  const minted = await reach(() =>
    mintLocalApiKey(session, {
      name,
      expiresAt: new Date(
        now.getTime() + capMs + RUN_KEY_EXPIRY_MARGIN_MS
      ).toISOString(),
    })
  );
  log.debug(`Minted the OmniRoute key ${name} (${minted.id}) for this run`);

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      await deleteLocalApiKey(session, minted.id);
      log.debug(`Deleted the OmniRoute key ${name} (${minted.id})`);
    } catch (error) {
      log.warn(
        `Could not delete this run's OmniRoute key ${name} (${errorMessage(error)}): it expires at ${minted.expiresAt}, and the next one-shot start sweeps it.`
      );
    }
  };
  return {
    facts: {
      ...withStack,
      storeEnv: { ...facts.storeEnv, [provider.apiKeyEnv]: minted.key },
    },
    release,
  };
}
