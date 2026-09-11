/**
 * Entry module of the egress API bundle (ADR-0012). esbuild bundles this file
 * and everything it imports into a single self-contained ESM script that
 * `e init` seeds into `.e/egress/egress-api.mjs`; the egress entrypoint runs
 * it with `node` next to dnsmasq. Keep it free of third-party imports.
 */

import http from 'node:http';
import { createEgressApi } from './api.js';
import { EGRESS_API_PORT } from './constants.js';

http.createServer(createEgressApi()).listen(EGRESS_API_PORT, '0.0.0.0', () => {
  console.log(`Egress API listening on port ${EGRESS_API_PORT}`);
});
