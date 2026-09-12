/** Docker network that owns the egress container's namespace. */
export const STACK_NETWORK = 'e-net';

/**
 * The shared egress container (ADR-0011). Started once by the local stack's
 * Compose file; a Run joins its network namespace rather than creating a
 * private network, so every container's traffic is logged and filtered.
 */
export const EGRESS_CONTAINER = 'e-egress';

/** Docker volume holding OmniRoute's persistent state. */
export const OMNIROUTE_VOLUME = 'omniroute-data';

/** Host- and netns-local port of the OmniRoute gateway (dashboard + API). */
export const OMNIROUTE_PORT = 20128;

/**
 * The port the egress HTTP API listens on inside the `e-egress` container
 * (ADR-0012). It sits here rather than with the other egress facts because
 * `shared/utils/env.ts` needs it to describe the host-side override, and
 * `shared` is below `sidecars`; the egress contract re-exports it so the
 * bundled server still reads every container-side fact from one module.
 */
export const EGRESS_API_PORT = 20129;
