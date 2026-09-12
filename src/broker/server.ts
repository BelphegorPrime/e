/**
 * Entry module of the runtime-broker bundle (ADR-0013). esbuild bundles this
 * file and everything it imports into one self-contained ESM script that
 * `e init` (or the first spawn that needs it) seeds into `.e/broker/broker.mjs`;
 * the `e-broker` image runs it with `node`. Keep it free of third-party imports.
 */

import http from 'node:http';
import { createBrokerApi } from './api.js';
import {
  BROKER_PORT,
  BROKER_SPOOL_ENV,
  BROKER_SPOOL_MOUNT,
} from './constants.js';

const spoolDir = process.env[BROKER_SPOOL_ENV] || BROKER_SPOOL_MOUNT;

http
  .createServer(createBrokerApi({ spoolDir }))
  .listen(BROKER_PORT, '0.0.0.0', () => {
    console.log(
      `runtime-broker listening on port ${BROKER_PORT}, spool ${spoolDir}`
    );
  });
