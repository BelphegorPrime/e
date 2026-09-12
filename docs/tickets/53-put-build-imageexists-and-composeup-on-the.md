# 53 - Put build, imageExists and composeUp on the ContainerRunner port

**Status:** Open, ready-for-agent.

**GitHub:** [#118](https://github.com/BelphegorPrime/e/issues/118)

---

**Found 2026-09-13 in an architecture review.** `ContainerRunner` (`ports/runtime/index.ts:84-134`) has 12 methods; the `ContainerRuntime` class has 17 public ones. The three it omits - `build`, `imageExists`, `composeUp` - are exactly what the port's busiest consumer needs, so `executeSpawn.ts:78` declares `runtime: ContainerRuntime`, **the class, not the port**, for 9 of the 15 production runtime calls. Its test then has to subclass the real class pointed at `/bin/true` (`executeSpawn.test.ts:119,136`) instead of implementing the interface, the way `FakeRuntime` and `RecordingRunner` do.

**What to build:** add the three methods to `ContainerRunner`; type `executeSpawn` and `cli/spawn.ts` on the port; give `FakeRuntime` (`runSpawn.testSupport.ts:18`) and `RecordingRunner` (`cli/transfer/runnerStub.ts:12`) the three methods; drop `RecordingRuntime extends ContainerRuntime` from `executeSpawn.test.ts` in favour of the port.

Scope is deliberately small - the argv-builder half is a separate ticket.

**Blocked by:** None.

- [ ] `ContainerRunner` carries `build`, `imageExists` and `composeUp`
- [ ] No production module is typed on the `ContainerRuntime` class
- [ ] No test subclasses `ContainerRuntime` or constructs it with a stand-in binary
- [ ] `rm -rf dist && npm test` green
