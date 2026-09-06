/**
 * An **Agent**: a named pairing of a Harness with, optionally, an inline
 * {@link Provider}. It is the selectable unit a Run executes. This module owns
 * the Agent shape and its resolution (pure core + filesystem glue); the
 * Registry never imports it, so the dependency runs one way:
 * `spawn`/`runs`/`init` → `agent` → `harness`/`store`.
 */
export * from './agent.js';