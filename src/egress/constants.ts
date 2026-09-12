/**
 * Fixed container-side facts of the egress gateway (ADR-0011 / ADR-0012).
 *
 * Shared by the CLI (which renders the build context, the compose file and
 * the entrypoint script) and by the API server that runs inside the
 * `e-egress` container (bundled from `./server.ts`). Keeping them in one
 * module means a path or port changes in exactly one place.
 */

/** Directory the compose file mounts for dnsmasq's query log. */
export const EGRESS_LOG_MOUNT = '/var/log/egress';

/** The dnsmasq log file, written inside the mounted log dir. */
export const EGRESS_DNSMASQ_LOG = `${EGRESS_LOG_MOUNT}/dnsmasq.log`;

/**
 * The host-editable dnsmasq blacklist, mounted read-write. Its `.blacklist`
 * suffix is what the entrypoint's `--conf-dir=/etc/egress.d/,*.blacklist`
 * glob picks up.
 */
export const EGRESS_BLACKLIST_MOUNT = '/etc/egress.d/dnsmasq.blacklist';

/**
 * The optional iptables script. Named `.rules` (not `.blacklist`) so the
 * dnsmasq conf-dir glob never tries to parse it as a dnsmasq config file.
 */
export const EGRESS_BLACKLIST_IP_MOUNT = '/etc/egress.d/iptables.rules';

/** The port the egress HTTP API listens on inside the container (ADR-0012). */
export const EGRESS_API_PORT = 20129;

/** Names that always resolve inside the stack: noise, not egress signal. */
export const EGRESS_LOCAL_NAMES: readonly string[] = [
  'localhost',
  'localhost.localdomain',
];
