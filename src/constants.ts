/** Docker network that owns the egress container's namespace. */
export const STACK_NETWORK = 'e-net';

/** Docker volume holding OmniRoute's persistent state. */
export const OMNIROUTE_VOLUME = 'omniroute-data';

/** Host- and netns-local port of the OmniRoute gateway (dashboard + API). */
export const OMNIROUTE_PORT = 20128;
