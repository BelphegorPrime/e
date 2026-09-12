/**
 * The host side of the runtime-broker (ADR-0013, ticket 02): how a run that
 * carries the `spawn-brother` skill gets its broker sidecar. The host owns the
 * run's **spool** directory - it writes the run's identity into it, bind-mounts
 * it into the broker, and (later tickets) consumes the sibling requests the
 * broker spools there. The broker container itself receives no runtime socket
 * and no credentials (ADR-0002): it is an HTTP front for files.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  BROKER_ALIAS,
  BROKER_IMAGE,
  BROKER_PORT,
  BROKER_SPOOL_MOUNT,
} from '../broker/constants.js';
import { ensureSpool, writeRunInfo } from '../broker/spool.js';
import type { BrokerRunInfo } from '../broker/types.js';
import type { SidecarSpec } from '../runtime/index.js';

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

/**
 * The spool of run `runName`: under the worktrees dir, because that is the one
 * host path every container engine is known to bind-mount (see
 * `worktreesDir.ts`); the `.broker` segment keeps it apart from worktrees.
 */
export function brokerSpoolDirFor(
  worktreesDir: string,
  runName: string
): string {
  return path.join(worktreesDir, '.broker', runName);
}

/** Creates the spool layout and records the run's identity for the broker to serve. */
export function prepareBrokerSpool(
  spoolDir: string,
  info: BrokerRunInfo
): void {
  ensureSpool(spoolDir);
  writeRunInfo(spoolDir, info);
}

/** Best-effort removal of a run's spool at teardown. */
export function removeBrokerSpool(spoolDir: string): void {
  fs.rmSync(spoolDir, { recursive: true, force: true });
}

/**
 * The broker's {@link SidecarSpec}: joins the run like an MCP sidecar (shared
 * egress namespace or the private run network), mounts the spool, and passes
 * no env-file - the broker holds no secrets.
 */
export function brokerSidecarSpec(
  plan: BrokerPlan,
  run: { runName: string; netns?: string; network?: string; spoolDir: string }
): SidecarSpec {
  return {
    name: `${run.runName}-broker`,
    alias: plan.alias,
    image: plan.image,
    port: plan.port,
    netns: run.netns,
    network: run.network,
    volumes: [{ host: run.spoolDir, container: BROKER_SPOOL_MOUNT }],
  };
}
