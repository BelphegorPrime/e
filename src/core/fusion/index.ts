/**
 * **Fusion** (ADR-0019): one task, several Agents, one result - combined at
 * the level of what the Agents produced, never of model weights. This module
 * owns the declarations and contracts: the Fusion profile's schema, its
 * validation against the Store's Agents and its loading, and the Candidate
 * result a synthesizer reads. Running a profile and writing its record live
 * above, in `engine/fusion`.
 */
export * from './profile.js';
export * from './load.js';
export * from './context.js';
export * from './result.js';
