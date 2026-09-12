# Planning tickets

Work items live as GitHub issues in `BelphegorPrime/e` (see
`docs/agents/issue-tracker.md`) - the issue is the source of truth. This
directory mirrors them as files so the backlog is readable offline, greppable
from a checkout, and linkable from ADRs.

Two kinds of file live here:

- **`01`-`08`** are the ADR-0013 planning write-ups. They were written before
  the work had issues and are referenced from the ADR, so they stay as they
  are. **`09`-`11`** are the same series; they now have issues too.
- **`12`-`61`** are one file per GitHub issue, oldest first, each carrying the
  issue's body verbatim under a status line and a link back.

When a ticket ships, add a status line at its top rather than deleting it. A
file is a copy: if it disagrees with its issue, the issue wins.

## ADR-0013 series (write-up first)

| File                                                                          | Status                                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`01`](01-env-injection.md) (env injection: `E_ROLE`, `E_BROKER_URL`)         | Done (2026-09-12). The role contract; see the ticket's top.                                                    |
| [`02`](02-runtime-broker-sidecar.md) (broker sidecar + `spawn-brother` skill) | Done (2026-09-12). Broker spools requests; no socket. See the ticket's top.                                    |
| [`03`](03-git-merge-primitive.md) (host Git merge primitive)                  | Done (2026-09-12). `Git.merge` with `merged` / `up-to-date` / `conflict` outcome.                              |
| [`04`](04-checkpoint-commit-on-spawn.md) (checkpoint commit on spawn)         | Done (2026-09-12). `runSpawn` with a `parent` checkpoints it and branches from the tip.                        |
| [`05`](05-artifact-sync-into-children.md) (artifact sync into children)       | Done (2026-09-12). Scratch copy + bind mount at `/workspace/<entry>`; `siblingArtifacts` config.               |
| [`06`](06-broker-endpoint-and-enforcement.md) (host side of sibling requests) | Done (2026-09-12). Consumer launches `e spawn` children; depth 403 / cap 429; `maxSiblings` config.            |
| [`07`](07-merge-back-flow.md) (merge-back flow)                               | Done (2026-09-12). Checkpoint + merge commit into the parent worktree; `held` / `conflict` + `--merge` signal. |
| [`08`](08-launch-prompt-and-e2e-test.md) (launch prompt, end-to-end test)     | Done (2026-09-12). Prompts via 01; the real-git cycle in `runSpawn.e2e.test.ts` (depth two, no `.env`/`.git`). |
| [`09`](09-spool-read-tolerance.md) (spool read tolerance)                     | Open, [#127]. A malformed status file crashes the host poll loop.                                              |
| [`10`](10-test-sleep-yield.md) (test sleep yields)                            | Open, [#128]. The no-op test sleep starved the event loop and hung a real-broker test.                         |
| [`11`](11-request-id-error.md) (request id error)                             | Open, [#129]. The id-format error gives no hint about the required shape.                                      |

[#127]: https://github.com/BelphegorPrime/e/issues/127
[#128]: https://github.com/BelphegorPrime/e/issues/128
[#129]: https://github.com/BelphegorPrime/e/issues/129

## Mirrored issues

| File                                                               | Issue                                                  | Status          | Title                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------ |
| [`12`](12-spec-isolate-every-run-in-a-per-run-git-worktree.md)     | [#1](https://github.com/BelphegorPrime/e/issues/1)     | Done 2026-08-08 | Spec: isolate every run in a per-run git worktree (host-driven git)                                          |
| [`13`](13-tracer-run-each-spawn-in-an-isolated-per-run-git.md)     | [#2](https://github.com/BelphegorPrime/e/issues/2)     | Done 2026-08-07 | Tracer: run each spawn in an isolated per-run git worktree                                                   |
| [`14`](14-run-identity-prompt-derived-slug-with-sequential.md)     | [#3](https://github.com/BelphegorPrime/e/issues/3)     | Done 2026-08-07 | Run identity: prompt-derived slug with sequential counter                                                    |
| [`15`](15-auto-push-successful-run-branches-to-origin.md)          | [#4](https://github.com/BelphegorPrime/e/issues/4)     | Done 2026-08-07 | Auto-push successful run branches to origin                                                                  |
| [`16`](16-extract-the-spawn-resolver-spawnplan-from-the-spawn.md)  | [#5](https://github.com/BelphegorPrime/e/issues/5)     | Done 2026-08-08 | Extract the Spawn resolver (spawnPlan) from the spawn command action                                         |
| [`17`](17-split-the-e-layout-out-of-harness-index-ts-into-a.md)    | [#6](https://github.com/BelphegorPrime/e/issues/6)     | Done 2026-08-08 | Split the .e layout out of harness/index.ts into a store module                                              |
| [`18`](18-collapse-docker-podman-runtime-subclasses-and-fix.md)    | [#7](https://github.com/BelphegorPrime/e/issues/7)     | Done 2026-08-08 | Collapse docker/podman runtime subclasses and fix build's effect model                                       |
| [`19`](19-make-the-agent-the-spawn-unit-default-agent-per.md)      | [#8](https://github.com/BelphegorPrime/e/issues/8)     | Done 2026-08-08 | Make the Agent the spawn unit (default agent per harness)                                                    |
| [`20`](20-favorite-harness-in-e-config-json-interactive-init.md)   | [#9](https://github.com/BelphegorPrime/e/issues/9)     | Done 2026-08-08 | Favorite harness in .e/config.json + interactive init + bare e spawn                                         |
| [`21`](21-custom-provider-via-env-with-protocol-set.md)            | [#10](https://github.com/BelphegorPrime/e/issues/10)   | Done 2026-08-08 | Custom Provider via env with protocol-set validation (Claude Code)                                           |
| [`22`](22-per-harness-config-adapter-rendered-file-derived.md)     | [#11](https://github.com/BelphegorPrime/e/issues/11)   | Done 2026-08-08 | Per-harness config adapter: rendered file + derived agent image (Codex)                                      |
| [`23`](23-tiers-and-auto-model-resolution-via-v1-models.md)        | [#12](https://github.com/BelphegorPrime/e/issues/12)   | Done 2026-08-08 | Tiers and auto model resolution via /v1/models                                                               |
| [`24`](24-composed-run-group-private-network-one-container.md)     | [#13](https://github.com/BelphegorPrime/e/issues/13)   | Done 2026-08-08 | Composed run group: private network + one container MCP sidecar wired to Claude                              |
| [`25`](25-remote-transport-mcp-servers.md)                         | [#14](https://github.com/BelphegorPrime/e/issues/14)   | Done 2026-08-08 | Remote-transport MCP servers                                                                                 |
| [`26`](26-mcp-for-file-based-harness-codex-capability-gating.md)   | [#15](https://github.com/BelphegorPrime/e/issues/15)   | Done 2026-08-08 | MCP for file-based harness (Codex) + capability gating (reject pi)                                           |
| [`27`](27-skills-baked-agent-defaults-per-run-skill.md)            | [#16](https://github.com/BelphegorPrime/e/issues/16)   | Done 2026-08-08 | Skills: baked agent defaults + per-run --skill                                                               |
| [`28`](28-e-env-injection-filter-to-declared-provider-mcp.md)      | [#24](https://github.com/BelphegorPrime/e/issues/24)   | Done 2026-09-05 | .e/.env injection: filter to declared provider + MCP keys (whitelist)                                        |
| [`29`](29-omniroute-bind-127-0-0-1-generate-stack-secrets-at.md)   | [#25](https://github.com/BelphegorPrime/e/issues/25)   | Done 2026-09-05 | OmniRoute: bind 127.0.0.1, generate stack secrets at e init (drop local-development defaults)                |
| [`30`](30-harness-containers-non-root-runtime-user-per.md)         | [#26](https://github.com/BelphegorPrime/e/issues/26)   | Done 2026-09-06 | Harness containers: non-root runtime user, per-harness override                                              |
| [`31`](31-egress-hardening-allow-list-provider-mcp-endpoints.md)   | [#27](https://github.com/BelphegorPrime/e/issues/27)   | Done 2026-09-07 | Egress hardening: allow-list provider + MCP endpoints for run containers                                     |
| [`32`](32-serve-detect-stale-detached-pid-in-serve-json-host.md)   | [#28](https://github.com/BelphegorPrime/e/issues/28)   | Done 2026-09-05 | serve: detect stale detached pid in serve.json (host reboot)                                                 |
| [`33`](33-spawn-keep-inline-omniroute-key-prompt-drive-sign.md)    | [#29](https://github.com/BelphegorPrime/e/issues/29)   | Done 2026-09-07 | spawn: keep inline OmniRoute key prompt, drive sign-in password from store env                               |
| [`34`](34-serve-branch-backed-api-runs-index-observer-first.md)    | [#30](https://github.com/BelphegorPrime/e/issues/30)   | Done 2026-09-05 | serve: branch-backed /api/runs/* index + observer-first read-only UI                                         |
| [`35`](35-documentation-explain-e-pi-relationship-and-agent.md)    | [#49](https://github.com/BelphegorPrime/e/issues/49)   | Done 2026-09-07 | Documentation: explain e/pi relationship and agent usage                                                     |
| [`36`](36-preparation-for-deploying-a-dedicated-local-ai.md)       | [#63](https://github.com/BelphegorPrime/e/issues/63)   | Done 2026-09-07 | Preparation for deploying a dedicated local AI runtime environment                                           |
| [`37`](37-feature-request-web-search-capability-for-harnesses.md)  | [#71](https://github.com/BelphegorPrime/e/issues/71)   | Done 2026-09-09 | feature request web search capability for harnesses                                                          |
| [`38`](38-wizard-overhaul.md)                                      | [#72](https://github.com/BelphegorPrime/e/issues/72)   | Done 2026-09-10 | wizard overhaul                                                                                              |
| [`39`](39-bash-tab-autocomplete.md)                                | [#75](https://github.com/BelphegorPrime/e/issues/75)   | Done 2026-09-10 | Bash Tab autocomplete                                                                                        |
| [`40`](40-agents-should-always-lint-code.md)                       | [#76](https://github.com/BelphegorPrime/e/issues/76)   | Done 2026-09-10 | agents should always lint code                                                                               |
| [`41`](41-evaluate-if-we-should-toogle-i-flag-from-spawn.md)       | [#78](https://github.com/BelphegorPrime/e/issues/78)   | Done 2026-09-10 | evaluate if we should toogle "-i" flag from spawn comand                                                     |
| [`42`](42-add-verbose-flags.md)                                    | [#85](https://github.com/BelphegorPrime/e/issues/85)   | Done 2026-09-10 | add verbose flags                                                                                            |
| [`43`](43-cut-the-dead-compose-log-surface-off-the.md)             | [#98](https://github.com/BelphegorPrime/e/issues/98)   | Done 2026-09-10 | Cut the dead compose/log surface off the ContainerRuntime seam                                               |
| [`44`](44-route-the-transfer-module-through-the.md)                | [#99](https://github.com/BelphegorPrime/e/issues/99)   | Done 2026-09-10 | Route the Transfer module through the ContainerRuntime seam                                                  |
| [`45`](45-collect-the-run-lifecycle-seams-delete-the.md)           | [#100](https://github.com/BelphegorPrime/e/issues/100) | Done 2026-09-10 | Collect the Run-lifecycle seams: delete the hypothetical ones, keep the Run orchestration as one deep module |
| [`46`](46-move-env-utilities-out-of-the-adapter-module.md)         | [#101](https://github.com/BelphegorPrime/e/issues/101) | Done 2026-09-10 | Move env utilities out of the adapter module                                                                 |
| [`47`](47-egress-log-orchestration-e-egress-query-mutation-api.md) | [#103](https://github.com/BelphegorPrime/e/issues/103) | Done 2026-09-11 | Egress Log Orchestration + e-egress Query/Mutation API                                                       |
| [`48`](48-leverage-docker-sbx.md)                                  | [#107](https://github.com/BelphegorPrime/e/issues/107) | Done 2026-09-11 | leverage docker sbx?                                                                                         |
| [`49`](49-e-spawn-with-a-prompt-should-run-one-shot-again-a.md)    | [#114](https://github.com/BelphegorPrime/e/issues/114) | Done 2026-09-12 | e spawn with a prompt should run one-shot again; a bare target opens the TUI                                 |
| [`50`](50-delete-the-pass-through-managers-around-the-host.md)     | [#115](https://github.com/BelphegorPrime/e/issues/115) | **Open**        | Delete the pass-through managers around the host ports                                                       |
| [`51`](51-split-childrun-so-every-caller-re-invokes-the-cli.md)    | [#116](https://github.com/BelphegorPrime/e/issues/116) | **Open**        | Split childRun so every caller re-invokes the CLI the same way                                               |
| [`52`](52-one-in-memory-git-adapter-instead-of-five-hand.md)       | [#117](https://github.com/BelphegorPrime/e/issues/117) | **Open**        | One in-memory Git adapter instead of five hand-written fakes                                                 |
| [`53`](53-put-build-imageexists-and-composeup-on-the.md)           | [#118](https://github.com/BelphegorPrime/e/issues/118) | **Open**        | Put build, imageExists and composeUp on the ContainerRunner port                                             |
| [`54`](54-absorb-the-runtime-argv-builders-and-test.md)            | [#119](https://github.com/BelphegorPrime/e/issues/119) | **Open**        | Absorb the runtime argv builders and test ContainerRuntime through its port                                  |
| [`55`](55-split-serve-ts-five-owners-in-one-869-line-file.md)      | [#120](https://github.com/BelphegorPrime/e/issues/120) | **Open**        | Split serve.ts: five owners in one 869-line file                                                             |
| [`56`](56-close-the-fileharnessadapter-one-method-instead-of.md)   | [#121](https://github.com/BelphegorPrime/e/issues/121) | **Open**        | Close the FileHarnessAdapter: one method instead of nine members                                             |
| [`57`](57-let-the-spawnplan-pipeline-actually-be-pure.md)          | [#122](https://github.com/BelphegorPrime/e/issues/122) | **Open**        | Let the SpawnPlan pipeline actually be pure                                                                  |
| [`58`](58-share-the-http-plumbing-between-the-broker-and.md)       | [#123](https://github.com/BelphegorPrime/e/issues/123) | **Open**        | Share the HTTP plumbing between the broker and egress sidecars                                               |
| [`59`](59-unify-the-two-a2a-remote-call-paths-and-break-the.md)    | [#124](https://github.com/BelphegorPrime/e/issues/124) | **Open**        | Unify the two A2A remote-call paths and break the spawn/a2a cycle                                            |
| [`60`](60-cover-the-modules-that-have-no-tests-at-all.md)          | [#125](https://github.com/BelphegorPrime/e/issues/125) | **Open**        | Cover the modules that have no tests at all                                                                  |
| [`61`](61-delete-the-dead-exports-in-the-spool-and-the.md)         | [#126](https://github.com/BelphegorPrime/e/issues/126) | **Open**        | Delete the dead exports in the spool and the sidecar renderers                                               |

## Architecture review, 2026-09-13

Files `50`-`61` came out of one deepening review of the whole tree. Two of its
findings shipped directly rather than as issues:

- **Run name has one owner** - `6c100cd`. `core/identity/runName.ts`; seven
  hand-derivations and two divergent counter regexes removed.
- **Child runs have one module** - `39d6556`. `engine/runs/childRun.ts`;
  `writeStatus` became the patch its type always claimed to be, which closed
  two field-loss bugs that had been hiding each other.

Cheapest of the rest to pick up: `58` and `61`. Most leverage: `52`.
