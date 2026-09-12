# 07 - Merge-back flow

**Shipped 2026-09-12.** `src/runs/runMergeBack.ts` is the primitive; the
`SiblingConsumer` (`src/runs/runSiblings.ts`) drives it. When a sibling
process exits, its spool record is **settled**: a `done` sibling that exited
0 is folded into the parent's live worktree - `mergeInProgress` check, then
`Git.commitAll` of the parent's uncommitted work on its own branch
(`e: checkpoint <parent> before merging <sibling>`, the ADR's "fold the
parent's WIP"; with `--no-ff` it must be the last index write, ticket 03),
then `Git.merge` as a merge commit (`e: merge back <sibling>`). Its files
appear in `/workspace` in place. Anything else (a failed sibling, a non-zero
exit, no branch) is `skipped` with the reason. The outcome is published twice:
into the sibling's status (`merge: { status, files?, reason? }`, `report`) so
`GET /status` / `spawn-brother.mjs --status` shows it, and as
`e-runs/<request id>/report.md` **inside the parent worktree** - the one place
the agent can read without a host path or git (the ADR's `e-runs/<child>`); it
is committed with the run's output like any file there.

Two waiting states, both with the files named, both moved on by the parent's
**signal** - a new broker route `POST /merge/<id>`, `spawn-brother.mjs --merge
<id>`, spooled as `signals/<id>.json` and taken by the consumer's tick:

- `conflict`: `Git.merge` left the markers in `merge.files`, `MERGE_HEAD` set;
  the host never resolves them. On the signal the host concludes the merge
  with `commitAll` (the merge commit, carrying the parent's current work too).
  While it is in progress every other finishing sibling is `held` ("another
  merge-back is in progress") and retried automatically once it concludes; a
  new sibling request is refused at its checkpoint (`commitAll` there would
  conclude the merge, markers and all).
- `held`: git refused because the parent's edits to `merge.files` landed
  between the checkpoint and the merge (in flight), or an untracked file was
  in the way. `Git.merge` now returns this as an outcome
  (`{ status: 'refused', files }`, parsed from git's message, ticket 03's
  open question) instead of throwing. On the signal, or when any other merge
  lands, the host checkpoints and retries.

The run's end is the last signal, on exit 0 only: after the parent's own
`e: run output` commit (which concludes a still-open conflict with whatever
the agent left in the files - visible, never chosen by the host),
`SiblingConsumer.finish` retries every `held` merge and reports a conflict
that commit concluded as `merged` with a `reason` saying so ("check them for
leftover conflict markers"); the reports those retries rewrite are committed
as `e: merge-back reports for <branch>`, and only then is the branch pushed,
so every merge commit and report travels with it. On a non-zero exit nothing
is committed and nothing retried: a `held` or `conflict` merge stays as it is
in the kept worktree (the report and skill say "exit code 0"). `RunSpawnResult.siblings` carries every sibling's
outcome; `e spawn` prints one line per sibling. Verified against real git in
`runMergeBack.test.ts` (clean merge, WIP fold, conflict -> held -> conclude ->
drain) and `runSpawn.e2e.test.ts` (the whole cycle over the real broker HTTP
handler, ticket 08); the consumer's states and signals with a scripted git in
`runSiblings.test.ts`; the broker route, spool signals and skill text in
`src/broker/*.test.ts`.

Decided: the report is keyed by request id (`sib-NNN`), the identity the agent
already holds from `POST /spawn`, not by branch - a sibling that never got a
branch still gets one. The report lands in the worktree and therefore in the
run branch; that is the deliverable the ticket asks for. A `done` sibling that
exited non-zero is not merged: `runSpawn` never captured its uncommitted work,
so its branch is the checkpoint it started from. Known limits: a merge held
over a race is retried only on a signal, when another merge lands, or at the
run's end, never on a timer (no commit spam while the agent keeps writing);
the host does not inspect resolved files for leftover markers - the agent's
signal is trusted, as its files are. Two processes touch the parent worktree's
index (this consumer, and the sibling `e spawn` process at its checkpoint,
ticket 04): a collision on `index.lock` during the merge is reported as `held`
("another git process was using your worktree") rather than `failed`, and
retried with the next landing or at the run's end; and the checkpoint's
`mergeInProgress` guard is a check-then-act, so a conflict that starts in the
same instant can still be concluded by that checkpoint. Every signal file is
consumed, also one for a merge that has moved on since (nothing to retry). A
`--merge` for a `held` sibling while another conflict is in progress lands it
back in `held` with that reason: resolve the conflict first.

**What to build:** After a child run exits, the host merges the child's branch into the parent branch using `Git.merge` (#3). If the parent has overlapping dirty edits, host folds parent's current WIP into the merge commit and updates the worktree in place; remaining in-flight overlap → merge held pending, parent told to clear files, host retries on signal. Child delivered via merged files in worktree + report at `e-runs/<child>/report.md`.

**Blocked by:** None - 03 (`Git.merge`) and 04 (`runSpawn` checkpoint via `parent`) shipped 2026-09-12.

**Status:** done

- [x] On child exit, host merges child branch into parent branch (merge commit)
- [x] Overlapping parent edits folded into merge commit; worktree updated in place (checkpoint commit, then the merge commit; the tree updates in place)
- [x] In-flight overlap → merge held pending; parent receives clear-files instruction; host retries after signal (`merge.status: held` + `files` in status and report; `POST /merge/<id>` / `--merge <id>`; also at run end)
- [x] Report written at `e-runs/<child>/report.md` for parent agent consumption (`e-runs/<request id>/report.md` in the parent worktree)
- [x] Merge conflict markers never silently auto-resolved (left in progress; concluded only on the parent's signal or by the run's own output commit)
- [x] Tests cover clean merge, WIP-fold, hold-pending path, report written
