# 60 - Cover the modules that have no tests at all

**Status:** Open, ready-for-agent.

**GitHub:** [#125](https://github.com/BelphegorPrime/e/issues/125)

---

**Found 2026-09-13 in an architecture review.** These modules have no co-located test **and** no test anywhere imports them. Two of them carry security-relevant logic.

| file                                     | lines | why it matters                                                                                                                                                                                                      |
| ---------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/engine/a2a/remoteSibling.ts`        | 172   | drives a Remote agent as a Sibling run and writes its status                                                                                                                                                        |
| `src/sidecars/broker/server/cli.ts`      | 152   | the `spawn-brother` CLI the agent in the container actually runs                                                                                                                                                    |
| `src/engine/a2a/remoteSpawn.ts`          | 98    | `e spawn <remote>` end to end                                                                                                                                                                                       |
| `src/core/localRuntimes.ts`              | 73    | `composeModelCatalog` has zero references from any test                                                                                                                                                             |
| `src/sidecars/egress/contract/domain.ts` | 35    | `isValidDomain` is a config-injection guard - its own doc says a bad domain "would inject or corrupt dnsmasq config and take the shared resolver down"; only reached indirectly through `egress/server/api.test.ts` |
| `src/sidecars/broker/contract/watch.ts`  | 32    | pure decision logic (`attentionSince`), sitting next to `taskState.test.ts` and `cliArgs.test.ts` which do test their neighbours                                                                                    |

Separately, `a2a/server.ts` (213), `a2a/jsonRpc.ts` (151) and `a2a/agentCard.ts` (103) are exercised end-to-end through Express by `interop.test.ts` and `serve.test.ts`, but have no unit-level test. That is defensible; the six above are not.

**What to build:** a test per module. Start with `domain.ts` and `watch.ts` - both are pure, both are minutes of work, and `isValidDomain` is a guard that should be pinned by adversarial cases.

**Blocked by:** None. Can land one file at a time.

- [ ] `isValidDomain` has adversarial cases (injection-shaped input, unicode, overlong labels, empty)
- [ ] `watch.ts`'s `attentionSince` is tested directly
- [ ] `composeModelCatalog` is tested
- [ ] `remoteSpawn` and `remoteSibling` have tests against a scripted A2A client
- [ ] `broker/server/cli.ts` has tests for its commands against a fake broker
- [ ] `rm -rf dist && npm test` green
