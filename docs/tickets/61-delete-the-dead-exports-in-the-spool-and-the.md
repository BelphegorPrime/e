# 61 - Delete the dead exports in the spool and the sidecar renderers

**Status:** Open, ready-for-agent.

**GitHub:** [#126](https://github.com/BelphegorPrime/e/issues/126)

---

**Found 2026-09-13 in an architecture review.** Exports that only their own tests call. Each one widens an interface without widening what the module does, and each forces a reader to work out whether it matters.

**`sidecars/broker/contract/spool.ts`**

- `hasMergeSignal` (`:166`) and `hasCancelSignal` (`:185`) - zero production callers; referenced only from `spool.test.ts:209-246`, `api.test.ts:320-402` and `runSiblings.test.ts:713-1044` as assertions. The production path uses `takeMergeSignal` / `takeCancelSignal`.
- `REQUEST_ID_PREFIXES` / `RequestIdPrefix` (`:35-36`) - referenced twice, both inside `spool.ts` itself.

**The render wrappers** - eight zero-argument functions returning a module-level `const`, each with exactly two non-test references: its own definition and its one use inside `renderXFiles()`. `broker/render.ts:47,52` and `egress/render.ts:202,211,216,221,226,231`. `egress/render.ts:208-210` states the reason outright: _"Kept as a function so callers stay uniform with the other renderers"_ - the interface exists for symmetry, not for a caller. What keeps them exported is that `render.test.ts` imports them individually.

**The bundler entry points** - `broker/server/server.ts` (24 lines) and `egress/server/server.ts` (14 lines) exist only so esbuild has something to point at (`scripts/build-broker.mjs:26-29`, `scripts/build-egress-api.mjs`). Their whole content is `http.createServer(makeApi()).listen(PORT)`; neither has a test. The only knowledge either holds is one env fallback (`broker/server/server.ts:16`). Point the bundler at `api.ts` and keep that fallback there.

**Blocked by:** None. Small; good first ticket.

- [ ] `hasMergeSignal`, `hasCancelSignal` and the request-id prefix exports are gone; the tests assert through the public reads instead
- [ ] The eight render wrappers are inlined into their `renderXFiles()`; `render.test.ts` asserts the rendered map
- [ ] Both `server/server.ts` files are gone and the bundles still build and run
- [ ] `rm -rf dist && npm test` green
