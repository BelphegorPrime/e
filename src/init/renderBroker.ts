/**
 * Renders the **runtime-broker** build context (ADR-0013): a Dockerfile and
 * the bundled broker server, seeded into `.e/broker/` the way the egress
 * gateway is seeded into `.e/egress/` (never clobbered, so a user can edit
 * them). The image `e-broker` is built once and started per run as a sidecar
 * when the run carries the `spawn-brother` skill.
 *
 *  - `Dockerfile`: `node:24-alpine` and the server script. No runtime socket,
 *    no credentials, no volumes declared: the host bind-mounts the run's spool
 *    at run time (ADR-0002 line held). Runs as root on purpose, like the egress
 *    gateway: the container is ours (trusted, secret-free) and has to write a
 *    host-owned bind mount, which root does under every engine (rootful
 *    docker, rootless podman, the macOS/Windows VMs) while a fixed non-root
 *    uid only matches hosts whose user happens to be uid 1000.
 *  - `broker.mjs`: not a template - the type-checked `src/broker/server.ts`
 *    and its imports, bundled by `scripts/build-broker.mjs`.
 */

import { BROKER_SERVER_BUNDLE } from '../broker/bundle.generated.js';
import { BROKER_PORT, BROKER_SPOOL_MOUNT } from '../broker/constants.js';

/** File names inside the broker build context. */
export const BROKER_FILES = {
  dockerfile: 'Dockerfile',
  serverScript: 'broker.mjs',
} as const;

export type BrokerFileName = (typeof BROKER_FILES)[keyof typeof BROKER_FILES];

const DOCKERFILE = `# The runtime-broker sidecar (ADR-0013). Started per run next to the agent
# container when the run carries the spawn-brother skill. It only serves HTTP
# over the run's network and spools sibling requests into ${BROKER_SPOOL_MOUNT},
# which the host e process bind-mounts and consumes: no container-runtime
# socket and no git credentials ever enter this container (ADR-0002).
FROM node:24-alpine

COPY ${BROKER_FILES.serverScript} /broker.mjs
RUN mkdir -p ${BROKER_SPOOL_MOUNT}

# Root on purpose (see renderBroker.ts): the spool is a host-owned bind mount
# this trusted, secret-free container must be able to write under any engine.
EXPOSE ${BROKER_PORT}
CMD ["node", "/broker.mjs"]
`;

/** Renders the `Dockerfile` for the broker container. */
export function renderBrokerDockerfile(): string {
  return DOCKERFILE;
}

/** The broker server script: the bundled, type-checked `src/broker/server.ts`. */
export function renderBrokerServerJs(): string {
  return BROKER_SERVER_BUNDLE;
}

/** The files seeded into `.e/broker/`, keyed by file name. */
export function renderBrokerFiles(): Record<BrokerFileName, string> {
  return {
    [BROKER_FILES.dockerfile]: renderBrokerDockerfile(),
    [BROKER_FILES.serverScript]: renderBrokerServerJs(),
  };
}
