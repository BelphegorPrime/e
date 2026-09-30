/**
 * **Fusion** (ADR-0019): one task, several Agents, one result - combined at
 * the level of what the Agents produced, never of model weights. This module
 * owns the Store side: the Fusion profile's schema, its validation against
 * the Store's Agents, and reading and writing it. The coordinator that runs a
 * profile lives above, in `engine/fusion`.
 */
export * from './profile.js';
export * from './load.js';
export * from './context.js';
