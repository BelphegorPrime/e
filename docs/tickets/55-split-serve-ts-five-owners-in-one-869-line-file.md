# 55 - Split serve.ts: five owners in one 869-line file

**Status:** Open, ready-for-agent.

**GitHub:** [#120](https://github.com/BelphegorPrime/e/issues/120)

---

**Found 2026-09-13 in an architecture review.** `src/cli/serve/serve.ts` is the largest non-test file in the tree and presents 14 exports across five unrelated concerns:

| lines      | concern                                                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:66-263`  | detached-server lifecycle - `serve.json` pid file, atomic write/rename, `process.kill(pid,0)` liveness, errno decoding, health probing, respawn with a 5s poll |
| `:265-368` | DI surface, `AgentSummary`, the Store read behind it                                                                                                           |
| `:370-675` | `createServeApp` - 17 routes, handlers inline                                                                                                                  |
| `:677-753` | two listeners plus the OmniRoute embed reverse proxy                                                                                                           |
| `:755-869` | `registerServeCommand` - flags, ports, engine socket, sessions, A2A, teardown                                                                                  |

Two handlers interleave route parsing with domain work and I/O: `handleRunRequest` (`:525-604`) does URL suffix-stripping, branch-to-Run translation, filesystem reads, git subprocess reads and SSE streaming in one function; `handleEgressRequest` (`:614-661`) is a hand-rolled reverse proxy sitting next to a library-based one in the same file. `errorMessage(error)` to a 500 appears five times.

`createServeApp(uiDirectory: string, deps)` makes a static-asset concern positional, so **nine** tests call `fs.mkdtemp` just to reach an API route. `serve.test.ts` is 1301 lines - 1.5x the module.

**What to build:** split by owner into `detachedServe`, `runsApi`, `egressProxy`, the app assembly and the command wiring. `uiDirectory` moves into `deps`. The runs handler becomes a module with an interface over Runs and Spools rather than over an express request, so the branch-to-Run reads are testable without HTTP.

**Note:** a pure file split only moves complexity. The measure of success is the runs handler getting a real interface and the API tests stopping their filesystem setup - not the line count per file.

**Blocked by:** None.

- [ ] `createServeApp(deps)`; no test creates a temp directory to reach an API route
- [ ] The runs handler is a module tested without an HTTP server
- [ ] One reverse proxy implementation, not two
- [ ] The error-to-500 mapping exists once
- [ ] The detached lifecycle is its own module with its respawn path tested
- [ ] `rm -rf dist && npm test` green
