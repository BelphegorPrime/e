/**
 * The sidecars a run brings up, as plan data.
 *
 * These types are the contract between the two halves of a spawn: `planSpawn`
 * decides which sidecars a run gets (purely, from the gathered facts) and
 * `runSpawn` starts them. They live here, below both, because the planner must
 * not import the orchestrator it sits above - that is what let the "pure plan"
 * of ADR-0008 quietly depend on the module that performs it.
 */

import {
  BROKER_ALIAS,
  BROKER_IMAGE,
  BROKER_PORT,
} from '../sidecars/broker/contract/constants.js';

/** A sidecar to bring up before the agent runs. */
export interface SidecarPlan {
  alias: string;
  image: string;
  port: number;
  healthcheck?: string[];
  /**
   * Env-files for the sidecar's own credentials (never the agent's). Wired at
   * execute time from the plan's `sidecarCredentials`; absent when the sidecar
   * needs none.
   */
  envFile?: string[];
}

/** The broker sidecar a spawn plans (present only when the run wants siblings). */
export interface BrokerPlan {
  /** Network alias the agent reaches the broker at (`runtime-broker`). */
  alias: string;
  /** The broker image tag (`e-broker`). */
  image: string;
  /** The port the broker listens on. */
  port: number;
}

/** The one broker there is: the shipped image at its alias and fixed port. */
export function defaultBrokerPlan(): BrokerPlan {
  return { alias: BROKER_ALIAS, image: BROKER_IMAGE, port: BROKER_PORT };
}
