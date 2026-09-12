# 18 - Collapse docker/podman runtime subclasses and fix build's effect model

**Status:** Done (closed 2026-08-08).

**GitHub:** [#7](https://github.com/BelphegorPrime/e/issues/7)

---

## What to build

`DockerRuntime` and `PodmanRuntime` are empty 5-line subclasses that only set `command`, fronted by a factory `Record` in `spawn.ts` — shallow inheritance carrying one string. Separately, the Runtime port is inconsistent about effects: `run()` returns an exit code and leaves lifecycle to the caller, but `build()` calls `process.exit()` on failure, so `ensureImage`'s documented "throws on failure" contract is only half-real.

Collapse the hierarchy and move the `build` failure effect to the edge.

- Make `ContainerRuntime` concrete: `constructor(readonly command: string)`. Delete `runtime/docker.ts` and `runtime/podman.ts`.
- `RUNTIMES` becomes a name→command map (`{ docker: 'docker', podman: 'podman' }`); `resolveRuntime` does `new ContainerRuntime(RUNTIMES[name])`. The `ContainerRunner` interface is unchanged (still the port `runSpawn` depends on).
- `build()` throws a plain `Error` on failure instead of `process.exit`/`console.error`; it propagates through `ensureImage` → `runSpawn` → the `spawn.ts` action's existing `try/catch`, which exits `1`. `build` keeps its informational `console.log`. (A build failure that today exits with docker's own code will now exit `1`, consistent with every other pre-run failure; docker's output still streams via `stdio: 'inherit'`.)

Principle: no `process.exit` inside the Runtime — the edge owns exits. `run` returns a code (a non-zero agent exit is a normal outcome); `build` throws (a failed build is an error condition).

## Acceptance criteria

- [ ] `ContainerRuntime` is a concrete class taking `command` via constructor; `docker.ts` and `podman.ts` are deleted.
- [ ] `RUNTIMES` is a name→command map and `resolveRuntime` constructs `new ContainerRuntime(...)`; auto-detection order (docker before podman) and the invalid/unavailable-runtime errors are unchanged.
- [ ] `ContainerRunner` interface is unchanged; `FakeRuntime` in existing tests still satisfies it.
- [ ] `build()` throws on failure (no `process.exit`, no `console.error`); a build failure surfaces via the action and exits `1`.
- [ ] New `src/runtime/runtime.test.ts` table-tests `buildRunArgs` argv construction (`-d` only when detached, `--rm`/`--name`/`-w`, `--env-file` ordering, then `-v`/`-p`/`-e`, image, command args). No runtime integration tests.
- [ ] `npm test` passes.

## Blocked by

- #6
