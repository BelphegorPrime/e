# 56 - Close the FileHarnessAdapter: one method instead of nine members

**Status:** Done (closed 2026-09-13), `5751900`.

**GitHub:** [#121](https://github.com/BelphegorPrime/e/issues/121)

---

**Found 2026-09-13 in an architecture review.** `HarnessAdapter` (`core/harness/adapter.ts:174`) is asymmetric. `EnvHarnessAdapter` has two members and is textbook deep. `FileHarnessAdapter` has nine, and **seven of them are read by exactly one caller**: `deriveImage.ts:183-218` reaches into the struct field by field and re-flattens the results into its own near-identical structs at `:24-28` and `:141`.

`modelInFile` is a boolean whose only purpose is to be branched on twice, four lines apart, in another module. `renderMcpServers?` is near-dead: only `codexAdapter` defines it, and its only non-test caller is `planConfigOverlay` in the same object, which calls `renderCodexMcpServers` directly anyway. `harness/index.ts:249-251`'s `fileAdapterFor` exists to dodge one cast and its single call site still needs two non-null assertions on one line (`:315`).

The union has **2 production consumers and ~33 test references**.

**What to build:** follow `planConfigOverlay`'s own example - its doc at `:150-161` says it exists so the spawn edge never has to know _where_ a harness reads its config. Each adapter returns a finished provider delivery from one method; `deriveImage` stops reassembling one.

**What to check while you are there:** `ConfigOverlayDelivery` (`:82-89`) leaks `mountTo` and a pre-formatted `env: string[]` back out - see whether the same treatment applies.

**Blocked by:** None.

- [ ] `FileHarnessAdapter` exposes `kind` plus one delivery method
- [ ] `deriveImage` no longer reads adapter fields individually or re-flattens them
- [ ] `fileAdapterFor` and its two `!` assertions are gone
- [ ] `renderMcpServers?` is gone
- [ ] Adding a file-config harness means writing one object, and a test says so
- [ ] `rm -rf dist && npm test` green
