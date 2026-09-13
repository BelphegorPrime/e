/**
 * The one effect that has to happen between `validateSpawn` and `planSpawn`:
 * bring the store's local OmniRoute stack up, and make sure the agent's
 * provider has an endpoint key that stack will actually accept.
 *
 * The two belong together and in that order - the key can only be created (or
 * checked) once OmniRoute answers - which is exactly why they live behind one
 * call instead of in the command action. They used to sit inline in `e spawn`'s
 * action closure, writing `localStackPresent` and the resolved key back into
 * `SpawnFacts` *after* validation had passed, which is what made the "pure
 * plan" of ADR-0008 untrue. Nothing is written back now: a run that needed a
 * new key gets a new `SpawnFacts` carrying it.
 *
 * Asking a human for the key is not this module's job - that is a terminal
 * interaction and belongs to the CLI, which passes it in as `askForKey`.
 */

import fs from 'node:fs';
import type { ContainerRunner } from '../../ports/runtime/index.js';
import { localStack } from '../../ports/runtime/stack.js';
import { envFilePath } from '../../core/store/paths.js';
import { log } from '../../shared/utils/log.js';
import { env } from '../../shared/utils/env.js';
import { errorMessage } from '../../shared/utils/errors.js';
import type { SpawnFacts } from './spawnPlan.js';
import {
  LocalApiKeyError,
  createLocalApiKey,
  needsLocalApiKey,
  providerTargetsLocalStack,
  upsertEnvValue,
} from './localApiKey.js';

/** What the CLI needs in order to walk the user through creating a key by hand. */
export interface ApiKeyRequest {
  /** The provider variable the answer is stored under, for the message. */
  apiKeyEnv: string;
  /** The stack's `OMNIROUTE_INITIAL_PASSWORD`, or '' - the dashboard login. */
  initialPassword: string;
  /** The agent asking, for the message. */
  agentName: string;
}

export interface LocalStackDeps {
  /** The resolved container runtime; only `composeUp` is used. */
  runtime: Pick<ContainerRunner, 'composeUp'>;
  /**
   * Obtains a key from the operator when OmniRoute's own API would not issue
   * one. Returns a non-empty key; persisting it is this module's job, not the
   * caller's.
   */
  askForKey: (request: ApiKeyRequest) => Promise<string>;
  /** Override the global `fetch`, so a test can script OmniRoute's answers. */
  fetchImpl?: typeof fetch;
}

/**
 * True when OmniRoute still honours `key`. A gateway that cannot be reached is
 * treated as accepting: a network blip must not send the user through the
 * key-creation handshake for a key that was fine.
 */
async function keyIsAccepted(
  key: string,
  fetchImpl: typeof fetch
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${env.omniRoutedUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    return response.status !== 401;
  } catch {
    return true;
  }
}

/**
 * Gets an endpoint key: first through OmniRoute's own API with the stack
 * password (no interaction), and if that login fails, by asking. Either way the
 * key lands in the store env under the provider's `apiKeyEnv`, and only there -
 * another agent's hosted key in the same `.e/.env` survives untouched.
 */
async function obtainKey(
  envFile: string,
  request: ApiKeyRequest,
  deps: LocalStackDeps
): Promise<string> {
  const key = await issueKey(request, deps);
  const content = fs.existsSync(envFile)
    ? fs.readFileSync(envFile, 'utf8')
    : '';
  fs.writeFileSync(envFile, upsertEnvValue(content, request.apiKeyEnv, key));
  return key;
}

/** The key itself: OmniRoute's API when it will, the operator when it will not. */
async function issueKey(
  request: ApiKeyRequest,
  deps: LocalStackDeps
): Promise<string> {
  if (request.initialPassword) {
    try {
      const key = await createLocalApiKey({
        baseUrl: env.omniRoutedUrl,
        password: request.initialPassword,
        name: `e (${request.agentName})`,
        fetchImpl: deps.fetchImpl,
      });
      log.success(
        `Created an OmniRoute API key for this agent and saved it as ${request.apiKeyEnv} in .e/.env.`
      );
      return key;
    } catch (error) {
      const reason =
        error instanceof LocalApiKeyError
          ? error.message
          : `OmniRoute is not reachable at ${env.omniRoutedUrl}: ${errorMessage(error)}`;
      log.warn(
        `Could not create an OmniRoute API key automatically (${reason}). If the stack was set up with a different OMNIROUTE_INITIAL_PASSWORD, restore it in .e/.env or remove the omniroute-data volume to reset the dashboard login.`
      );
    }
  }
  return deps.askForKey(request);
}

/**
 * Brings the local stack up (when the store has one) and returns the facts the
 * plan should be built from: the same value, or a copy whose `storeEnv` carries
 * a freshly issued OmniRoute endpoint key.
 *
 * Only an agent whose provider actually points at the local OmniRoute is ever
 * asked for a key - a hosted Anthropic or OpenAI key is never checked, never
 * prompted for, and never overwritten (`localApiKey.ts` owns that rule).
 */
export async function prepareLocalStack(
  facts: SpawnFacts,
  deps: LocalStackDeps
): Promise<SpawnFacts> {
  if (facts.localStackPresent) {
    const stack = localStack(facts.root);
    // The stack is interpolated from `.e/.env` (no fallback secrets), so pass
    // it explicitly - compose does not otherwise look inside `.e/`. A stack
    // with no local runtime renders no bootstrap service to wait for.
    if (stack) {
      deps.runtime.composeUp(
        stack.composeFile,
        stack.envFile,
        facts.localRuntimes.length > 0
      );
    }
  }

  const provider = facts.agent.provider;
  if (!provider) return facts;

  const configuredKey = facts.storeEnv[provider.apiKeyEnv] ?? '';
  const stackPassword = facts.storeEnv.OMNIROUTE_INITIAL_PASSWORD ?? '';
  // Only a key that could plausibly still work is worth a round trip: an empty
  // one, the initial password, or a hosted provider needs no asking.
  const worthChecking =
    facts.localStackPresent &&
    providerTargetsLocalStack(provider) &&
    configuredKey !== '' &&
    configuredKey !== stackPassword;
  const accepted = worthChecking
    ? await keyIsAccepted(configuredKey, deps.fetchImpl ?? fetch)
    : true;

  if (
    !needsLocalApiKey({
      stackPresent: facts.localStackPresent,
      provider,
      configuredKey,
      stackPassword,
      accepted,
    })
  ) {
    return facts;
  }

  const key = await obtainKey(
    facts.baseEnvFile ?? envFilePath(facts.root),
    {
      apiKeyEnv: provider.apiKeyEnv,
      initialPassword: stackPassword,
      agentName: facts.agent.name,
    },
    deps
  );
  return {
    ...facts,
    storeEnv: { ...facts.storeEnv, [provider.apiKeyEnv]: key },
  };
}
