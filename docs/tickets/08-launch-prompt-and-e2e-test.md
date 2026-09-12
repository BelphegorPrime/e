# 08 - Launch-prompt role guidance and end-to-end test

**Shipped 2026-09-12.** The prompt half came with ticket 01: `launchPrompt`
in `src/runs/runSpawn.ts` names the role and both variables for parent and
child and forbids marker files. The end-to-end cycle is
`src/runs/runSpawn.e2e.test.ts`, with the real pieces the host owns and fakes
only where a container would be: a real git repo and `HostGit`, the real
broker HTTP handler (`createBrokerApi`) over the spool the parent run creates,
and siblings that run the real `runSpawn` pipeline in-process from the markers
the consumer hands them (what the `e spawn` child process does). The fake
container runtimes' `onRun` play the agents. The parent asks the broker for a
sibling and keeps editing; the child sees its markers and a "child" launch
prompt and asks the parent's broker for a sibling of its own, which becomes
`sib-002` under the parent (depth two, never three); both merge back into the
parent's live worktree while it still runs, reports in `e-runs/`; a third
sibling conflicts with the parent's post-checkpoint edit, the parent resolves
and signals `POST /merge/<id>`, the host concludes; the run ends with three
merge commits, a clean kept worktree, the reports committed. The child's
mounts show `node_modules` as a scratch copy beside its worktree and neither
`.env` (top-level or nested) nor `.git` anywhere a child can reach - the
worktree's `.git` is a pointer file to the host repo. A separate consumer test
(`runSiblings.test.ts`, "depth limit") covers a child-role spool refusing
requests; the broker's `403` is in `api.test.ts`.

A previous attempt (run-132, merged as PR #110) had written an "e2e" against a
fake git and a `node -e` stand-in for the sibling process; it is replaced by
this one. Its findings stand as tickets 09-11.

**What to build:** Parent and child launch prompts instruct agents to check `$E_ROLE` / `$E_BROKER_URL` and state role behavior explicitly (no marker files). An end-to-end test runs the full cycle: parent spawns child via broker, child observes env, child requests a sibling, run completes, parent worktree contains sibling's merged changes.

**Blocked by:** None - 02, 06 and 07 shipped 2026-09-12.

**Status:** done

- [x] Parent launch prompt references `$E_ROLE`/`$E_BROKER_URL` and role behavior (ticket 01)
- [x] Child launch prompt references `$E_ROLE`/`$E_BROKER_URL` and role behavior (ticket 01)
- [x] Neither prompt references or depends on marker files (ticket 01: the prompt forbids them)
- [x] E2E test: parent spawns child, child sees env, child spawns sibling, parent ends with merged changes (`runSpawn.e2e.test.ts`)
- [x] E2E test asserts depth cap enforced and `.env`/`.git` absent from child (the child's request becomes the parent's `sib-002`; no `.env` in the artifact copy or the child worktree, no `.git` in the copy, the worktree's `.git` a pointer file)
