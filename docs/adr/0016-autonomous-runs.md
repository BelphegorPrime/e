# ADR-0016: Autonomous runs - the verify gate, the loop, and what may start a run without a human

**Status:** Proposed
**Date:** 2026-09-19
**Related:** [ADR-0001 (per-run git worktree)](./0001-per-run-git-worktree.md), [ADR-0002 (host orchestrates git)](./0002-host-orchestrates-git.md), [ADR-0003 (run identity and ledger)](./0003-run-identity-and-ledger.md), [ADR-0005 (composed container groups)](./0005-runs-as-composed-container-groups.md), [ADR-0006 (per-harness config adapter)](./0006-per-harness-config-adapter.md), [ADR-0011 (egress blacklist netns)](./0011-egress-blacklist-netns.md), [ADR-0013 (nested spawn via runtime-broker)](./0013-nested-spawn-via-runtime-broker.md), [ADR-0015 (A2A vocabulary and remote agents)](./0015-a2a-vocabulary-facade-and-remote-agents.md)

## Context

Every run `e` starts today is typed by a human who then reads the result. That
human is load-bearing in four places at once, and nothing in the codebase names
the fact:

- **What "done" means.** `runSpawn` commits and pushes on `exitCode === 0`
  (`src/engine/runs/runSpawn.ts:499`). Research against all four harnesses
  (pi 0.85.1, Claude Code 2.1.267, Codex 0.147.0, opencode 1.18.31) found that a
  refusal, a hit guardrail and a blocked tool call **exit 0 on all four**. So the
  harness exit code was never a verdict; we are saved only by the accident that a
  refusing agent leaves the worktree clean and `git.isDirty()` is false. The same
  pass found `codex exec` running under a **read-only sandbox** - its writes
  denied, the denials fed back to the model, the process exiting 0 and the
  worktree empty - a live bug, not a hypothetical.
- **Who judges it.** The human reading the PR.
- **Who stops it.** The human with Ctrl-C. There is no wall-clock bound, no
  iteration bound, and no memory or CPU bound on any run.
- **What may start one.** Only `e spawn`, from a shell, or the BFF surfaces that
  wrap it.

Autonomy is the decision to remove that human from the first three and to add
non-human entries to the fourth. This ADR fixes the contract that replaces them.

Its scope boundary is one sentence: **autonomy ends at an open PR.** Nothing here
merges anything, and the human who reads the PR is the reviewer we still have.

## Decision

### 1. The autonomy contract

| Question                              | Answer                                                                                                                                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What does "done" mean?                | A **verify** command, declared per repository, exits 0 against the run's worktree. Where no verify is declared there is no loop and no verdict: a run is one iteration, exactly as today.                                                 |
| Who judges it?                        | A second container, started by the host, running the repository's own command. Not the harness, which would let the thing being judged file its own report; not the host shell, which is what `e`'s container boundary exists to prevent. |
| Who stops it?                         | The host, on caps it owns: iterations, wall clock per iteration and in total, memory, CPU, pids. The agent is never told its remaining budget.                                                                                            |
| What may start a run without a human? | A **trigger**: a named Store entity binding one event source (a webhook delivery, a cron tick) to one agent and one prompt template.                                                                                                      |

The harness exit code keeps exactly one job: **liveness**. Non-zero means the
process definitely failed; zero means it finished and nothing more.

### 2. The verify gate

Declared per Store, which is to say **per repository, not per agent** - the check
belongs to the repo, not to the model running against it.

```jsonc
// .e/config.json
"verify": "npm test"                      // shorthand

"verify": {
  "command": "npm ci && npm test",
  "image": "golang:1.23",                 // optional; default: the run's harness image
  "timeoutMs": 900000,                    // optional; default from `loop`, below
  "network": true,                        // optional
  "cache": true,                          // optional; package cache mount, off by default
  "guards": ["**/*.test.*", "test/"]      // optional; see 11
}
```

**A second container run** against the same worktree. `image` defaults to the
run's harness image and exists because all four harness images are
`node:lts-alpine` plus git plus the harness CLI: a harness-image-only gate is
dead on arrival against a Python, Go or Rust repo.

**Verify installs its own dependencies.** No artifact sync into the verify
container: `siblingArtifacts` copies **host-built** `node_modules`, and alpine is
musl, so native modules built against glibc do not run there. `cache` mounts a
package cache outside the worktree (`~/.npm`, `~/.cache/pip`) as an opt-in named
volume, shared per Store; two concurrent runs share it, which npm tolerates and
pip may not.

**Which runs are gated.** Every non-interactive run of the user's own. Not an
interactive run, which has its human in front of it, and **not a sibling**: a
sibling opens no PR and its work reaches the parent by merge-back, so the
parent's own gate covers the merged whole and a per-sibling check would pay for
the same verdict twice.

**No provider credentials reach the verify container.** Verify is not an agent,
and a tampered check that can call the model can buy its way to green. Network is
available, through the same egress containment as the run itself (ADR-0011),
because installing dependencies is now verify's own job.

**The verdict taxonomy divides on whose fault it could be:**

| Outcome                                                                         | Verdict                                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Verify exits non-zero                                                           | **Red** - feed the output back, iterate                                   |
| Verify times out                                                                | **Red** - a hanging suite is often the infinite loop the agent just wrote |
| Image missing, container fails to start, command not found (including exit 127) | **Abort the run** - push the branch, no PR, non-zero exit                 |

Iterating against a broken check burns the whole budget to learn nothing and
reports a red the agent cannot act on. Accepted caveat: a test runner that
legitimately exits 127 is misread as a broken check. Loudly wrong beats silently
looping. A timed-out check reports `124`, the `timeout(1)` convention, because
the container was killed before it said anything - the number is `e`'s statement
and not the check's, and the recorded reason is what separates it from a check
that genuinely exited 124.

**The gate's own writes are not the run's.** A run's worktree is torn down only
when it is clean, so that uncommitted work is never silently discarded. Once the
check has run, what is left there is its `node_modules`, `.venv` or `target/` -
the run's own work was committed immediately before the check started, by
construction - so after a gated run the worktree is removed regardless. Without
that, every gated run would strand its worktree on disk.

### 3. The loop

The loop lives in `runSpawn`, not in `serve`, so every deployment shape gets it.
One iteration is:

```
launch -> harness run -> commit -> verify -> feedback -> repeat
```

A **fresh container per iteration**; context is carried by the worktree, not by a
session. The loop exits on a green verify (open the PR), on cap exhaustion, or on
a non-zero harness exit.

**Commit every iteration, red or green.** Verify reads the worktree, so ordering
decides exactly one thing: whether a red iteration leaves a commit behind. It
must - exhaustion pushes the branch, uncommitted work is never pushed, and the
final red attempt is the one a human most needs to read. Committing first also
keeps verify's own writes (`node_modules`, `.venv`, `target/`) out of the run's
commits without trusting a stranger's `.gitignore`.

**A non-zero harness exit aborts the loop and never retries.** That is liveness:
a crash, an OOM, a kill. Nothing is committed for the dead iteration, and the run
takes the exhaustion path - push the branch, open no PR, exit non-zero. Retrying
hopes the same input behaves differently and burns budget on an infrastructure
problem while looking like progress. The one carve-out is a wall-clock kill; see 4.

**Feedback is a byte-bounded tail appended to a restated prompt.** A fresh
container has no conversational memory, so the next prompt restates the task in
full and appends roughly 4 KB of the combined, interleaved stdout+stderr tail,
with the truncation marked. A tail because test runners put the actionable
summary last; a byte budget because a line count means nothing across tools.

**The agent learns the attempt ordinal and never the remaining budget.** The
ordinal it needs: a fourth attempt at the same failure is the signal to question
the approach rather than re-apply the fix, and a fresh container cannot otherwise
tell. The countdown is a hazard: the cheapest way to turn `npm test` green on a
last attempt is never a real fix, it is `.skip`, a loosened assertion, `|| true`,
a deleted test - and because the exit code is the verdict, that hack _works_. The
cap is a host-side safety limit, not a task parameter.

**The launch prompt declares the gate, with the container caveat:**

> When your run ends, e runs `npm test` in a separate container against this
> worktree; its exit code decides whether the work is accepted. That container is
> not this one - do not assume you can run the command here.

Deliberately absent: any statement that no human is watching. It reads as _be
careful, you are the last line_ to one agent and _nobody is checking_ to another,
and the exit code cannot tell us which we got.

**Reporting.** `RunSpawnResult` gains `iterations?: IterationOutcome[]`,
undefined when no verify is declared, so today's runs produce today's report with
no flag to read. Each entry carries the ordinal, the harness exit code, the commit
sha, the verify verdict and the verify exit code, plus an explicit
`verified` / `exhausted` / `aborted` discriminator rather than one derived from
the last entry.

### 4. Caps and exhaustion

Caps are **two classes with different reach**, and the config says so:

```jsonc
// .e/config.json
"resources": { "memory": "4g", "cpus": 2, "pidsLimit": 2048 },
"loop": {
  "maxIterations": 3,
  "iterationTimeoutMs": 1800000,
  "totalTimeoutMs": 10800000,
  "softTotalTimeoutMs": 7200000
},
"dead": { "maxAgeMs": 604800000, "maxEntries": 100 }
```

- **`resources`** applies to **every** run, interactive included, and to the
  verify container. A manual `e spawn` can take the host down exactly as easily
  as a triggered one. Not to sidecars: those are `e`'s own infrastructure, small
  and known, and limiting them breaks `e` in a way the user cannot diagnose.
- **`loop`** applies only where `verify` is declared, because a loop exists
  structurally nowhere else. Its `iterationTimeoutMs` covers every
  **non-interactive** run - a run without verify is a loop of length one, and a
  hung container is the same problem there. `--interactive` is exempt: killing a
  human's live session at 30 minutes is hostile.

**Defaults, chosen as a set** (a run's worst case is
`maxIterations x (iterationTimeoutMs + verify timeoutMs)`, so `totalTimeoutMs`
must sit above it or `maxIterations` is a lie):

| Setting                              | Default                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `loop.maxIterations`                 | `3` (three harness runs in total, not one plus three retries)                              |
| `loop.iterationTimeoutMs`            | 30 min - two to three times a normal run, so it catches hangs and does not punish slowness |
| `loop.totalTimeoutMs`                | 3 h - just above the worst case, so it never shadows `maxIterations`                       |
| `loop.softTotalTimeoutMs`            | 2 h                                                                                        |
| `verify.timeoutMs`                   | 15 min                                                                                     |
| `resources.pidsLimit`                | `2048`                                                                                     |
| `resources.memory`, `resources.cpus` | **unset**                                                                                  |

Unset is the point for memory and CPU: `resources` applies to the whole installed
base, and any concrete number is a guess about someone else's hardware that turns
a passing build into a 137. `pidsLimit` is the exception, because a fork bomb is
the one failure that takes the box rather than the run. Honest price: the memory
safety limit is off by default, and whoever runs `e serve` unattended has to
switch it on.

**Overrides: exactly two layers.** The Store `config.json` is the base; a trigger
may override `loop`, field-wise, in both directions. No CLI flag (that is the
task parameter section 3 ruled out, and whoever typed `e spawn` has Ctrl-C), no
env var (env here is host plumbing, not a tunable, and an invisible channel is
the wrong shape for a safety limit). `resources` has no override layer at all.

_Scaffolding, until the `loop` block exists:_ the loop ships ahead of the caps,
so `E_MAX_ITERATIONS` carries the iteration budget in the meantime, defaulting
to 3. It is host-side only and reaches no container, so no agent can raise its
own budget - but it is the env var this section rules out, and the caps work
replaces it with `loop.maxIterations` rather than keeping both.

**The Store number is a default, not a ceiling.** A ceiling protects against
nobody: the same human writes both files. The threat model is the agent raising
its own budget, and **the agent reaches neither file** - `.e` is gitignored, so it
never appears in a fresh worktree, and the run container mounts only the worktree
plus the artifact and config mounts. That structural fact, not a convention, is
what makes a cap a safety limit.

**The kill is SIGKILL**, reusing `removeContainer` (`rm -f`), with no grace
period: the work is already on disk because the worktree is a bind mount, and
SIGTERM would end the container on 143, which is `CANCELED_EXIT_CODE`. 137 is
unambiguous.

**A timed-out iteration commits its partial work**, under a distinct message
(`e: timed-out attempt 3 for <branch>`). This is a third case rather than a
weakening of section 3: the host knows it was the cause and chose the moment, so
the worktree holds "what the agent had at minute 30" rather than "what survived
an unknown fault" - and nothing is fed forward, because the run ends. Without it
the work is lost outright.

**The hard total timeout kills mid-iteration.** A boundary-only check cannot keep
its promise: with 2 h total and 30 min per iteration, an iteration starting at
1h59 still sees budget and runs to 2h29. **`softTotalTimeoutMs` is checked at the
boundary and only warns** - into the log, the report and `GET /api/runs`, and
**never into the prompt**, for the same reason the countdown is withheld from the
agent. It is named for its eventual role (refusing to start an iteration past the
mark) because renaming a config key later is the expensive move.
`softTotalTimeoutMs >= totalTimeoutMs` is rejected by `resolveConfig` with a log
line, following the per-key fallback pattern already there.

**Exit codes** - the run's verdict, no longer the harness's:

| Outcome                                        | Code                        |
| ---------------------------------------------- | --------------------------- |
| `verified`, or a non-looping run that exited 0 | `0`                         |
| `aborted` (harness died, OOM, broken verify)   | `1`                         |
| `exhausted` (caps spent, verify still red)     | `2`                         |
| `canceled`                                     | `143` (ADR-0015, unchanged) |

`exhausted` is separate because it is the one outcome a caller plausibly branches
on: "out of budget, maybe re-queue with more" is a different reaction from "it
broke". An OOM kill is `aborted`, not red - the agent can do nothing about too
little memory. An OOM and our own timeout both end the container on 137 and are
separable only host-side (_our timer fired_ or not), so the outcome carries the
reason: `exhausted:iterations` / `exhausted:iteration-timeout` /
`exhausted:total-timeout`, `aborted:oom` / `aborted:harness-exit` /
`aborted:verify-broken`.

**A slot frees at terminal, after teardown**, not at the kill: commit, push and
worktree removal are not milliseconds, and a run that is still pushing still holds
disk and network.

### 5. Triggers

A trigger is a **named Store entity**, mirroring `agents/<name>/agent.json`. The
directory name is the trigger id and the dedup-key prefix.

```jsonc
// .e/triggers/<name>/trigger.json
{
  "enabled": true, // optional, default true
  "agent": "claude-pr", // required
  "repo": "/home/me/projects/e", // only meaningful in a home Store
  "base": "{{pull_request.head.ref}}", // optional, default the repo's default branch
  "prompt": "Fix issue #{{issue.number}} in {{repository.full_name}}.",
  "dedup": "issue.number", // optional
  "overlap": "skip", // optional, default "skip"
  "loop": { "maxIterations": 10 }, // optional, field-wise over the Store
  "on": {
    "type": "webhook",
    "source": "github",
    "event": "issues", // X-GitHub-Event
    "action": "labeled", // payload.action
    "match": { "label.name": "agent" },
  },
}
```

A long prompt may live as `prompt.md` beside `trigger.json`, which is why this is
a directory. Not a block in `config.json`: that file holds single-valued host
settings, not a registry of named entities.

**One event source per trigger.** Two would make `<trigger id>:<event dedup
value>` draw its halves from two vocabularies. Webhook events are named **as the
provider names them**; `e` ships no event catalogue, because a mapping table for
four forges goes stale on someone else's release schedule and `e` is not a forge
client. Accepted cost: a typo in an event name never fires, silently, and shows up
only in the log of unmatched deliveries.

**Filtering is exact-match only.** `match` is an object of dotted payload paths to
expected values, ANDed; an array value is OR. No regex, no negation, no operators.
The payload is attacker-controlled, and anything that evaluates expressions
evaluates them against a stranger's data. Not filtering at all was rejected
outright: every label click on every issue would start a container and take a
queue slot, a denial of service against your own queue paid for at the provider.

**A prompt cannot be sanitized.** To a model any interpolated text is
instruction-shaped, and escaping defends against HTML, not against "ignore
previous instructions". The dividing line is that **identifiers can be validated
and prose cannot**. Interpolation (Mustache, already a dependency) is restricted
to this whitelist:

| Path                                       | Pattern                              |
| ------------------------------------------ | ------------------------------------ |
| `issue.number`, `pull_request.number`      | `^[0-9]+$`                           |
| `ref`, `base_ref`, `pull_request.head.ref` | `^[A-Za-z0-9._/-]+$`                 |
| `sha`, `after`                             | `^[0-9a-f]{7,40}$`                   |
| `sender.login`                             | `^[A-Za-z0-9-]+$`                    |
| `label.name`                               | `^[A-Za-z0-9 ._-]+$`                 |
| `repository.full_name`                     | `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`  |
| `{{tick}}`, `{{trigger}}`                  | host-generated, not from the payload |

A value that fails its pattern **drops the event**, logged; never coerced, never
truncated. `title`, `body`, `comment.body` and every other free-prose field are
**not interpolable at all** - the agent has the issue number and fetches the text
itself, and text it fetched is legibly a finding rather than an order from its
operator. For the agent that wants the whole thing, the **full payload is mounted
read-only at `/run/e/event.json`, outside the worktree**, so it can never ride
along in a `commitAll`. Fencing prose in delimiters was rejected: the delimiter is
itself just text in the prompt.

**`agent` is required.** Falling back to `defaultHarness` was rejected - that
default is a convenience for a human who can retype, and a trigger cannot; it
would also mean editing `config.json` silently changes who runs tonight.

**`base` defaults to the repository's default branch** (`origin/HEAD`), not to
`git.currentBranch()`. Today's default is right for a typed `e spawn`; for a
nightly cron it is whatever somebody left checked out yesterday evening.

**Which repo a run targets is a chain**: a repo-local Store targets its own
repository and ignores `repo`; a home Store uses the trigger's `repo`; neither is
a load error. `verify`, `loop` and `resources` resolve along the same chain - the
target repo's `.e/config.json`, then the serving Store's, then the built-in
defaults - which keeps the check with the repository. The queue and ledger stay
with the **serving** Store: slots bound how many containers this machine runs.

**Dedup**: absent, the source supplies its own identity (the delivery id, the
tick). Declaring a path **coarsens** the key into coalescing -
`"dedup": "issue.number"` turns three label clicks into one run. A declared path
missing from the payload drops the event, logged; falling back would silently
widen the key and turn a misconfigured trigger into a queue flood.

**`overlap: "skip" | "allow"`** (default `skip`, any trigger type): at fire time,
if this trigger already owns an entry in `live/`, the event is dropped with a log
line. Two nightlies branch off the same base and race each other into two PRs.

**`enabled: false`** switches a trigger off in place. Renaming the directory was
rejected because the name is the id and therefore the dedup prefix.

### 6. Queue, ledger, and dead requests

Three file-backed spools under the serving Store, gitignored with the rest of
`.e/`:

| Directory        | Holds                                                        |
| ---------------- | ------------------------------------------------------------ |
| `.e/runs/queue/` | pending trigger **requests** - no branch, no identity yet    |
| `.e/runs/live/`  | **runs** that exist, from claim to terminal-within-retention |
| `.e/runs/dead/`  | requests that died **before** a run branch existed           |

One file per entry, atomic temp+rename, a corrupt or half-written file reading as
absent: the `src/sidecars/broker/contract/spool.ts` pattern, reused rather than
reinvented. The payload lives **inline** in the record - a sidecar payload file
would end the single-rename claim, and a crash between two renames leaves a record
that is perfectly present with its payload gone, a case the half-written rule does
not cover.

**No queue library and no database.** `@boringnode/queue` on Kysely over
`node:sqlite` was the only candidate clearing the `pkg --sea` no-native-addon bar,
and it solves contention, backoff and throughput - problems a single consumer with
two slots and a handful of jobs an hour does not have. The filesystem gives the
rest directly: the claim **is** `rename(queue/<key>, live/<key>)`, the dedup key
**is** the filename, max length is a `readdir` count, TTL is a field and a sweep.

**Identity**: `trg-<ulid>` from `ulid`'s `monotonicFactory()`, naming the
**request**, not the run - the move `spool.ts` already makes with `sib-NNN`. The
`run` field is null while `queued` and set at claim. ADR-0003 is untouched.

**Overflow rejects the new event** (429 at the webhook edge). Drop-oldest discards
work already accepted and makes the queue lie about what it took.

**Restart reconciles, never resumes.** Each `live/` entry is checked against
reality by **container name** - deterministic, and the thing actually holding
resources. Container gone: `interrupted`, slot freed, branch stays, no retry.
Container alive: left alone, slot held, but not streamed; `serve` lost the
process, not the run. Loop state lives in the worktree, and re-entering an
iteration after a crash risks a double commit. Known sharp edge, documented rather
than repaired: during a normal teardown the container is also already gone, so a
restart inside that narrow window marks a healthy teardown `interrupted`.

**A manual `e spawn` writes a ledger entry and consumes no slot.** The ledger
describes what is running; slots gate only what autonomy may _start_, and the
human who typed it has already decided. This also closes today's blind spot, where
a plain spawn records nothing.

**Retention**: a terminal ledger entry lives about an hour, then is swept. Long
term history stays branch + PR + provenance trailer, per ADR-0003; the ledger never
becomes an archive.

**Dead requests.** The line is that **no run branch ever existed**: TTL expiry,
overflow rejection, an unresolvable `base`, a launch failure. Out: `interrupted`,
exhausted, aborted and verify-red, each of which already has a branch, a PR and a
trailer - duplicating them would be a second, worse ledger. TTL expiry becomes
`rename(queue/<key>, dead/<key>)`, so every exit from `queue/` is a rename.

It is **not a DLQ** and is deliberately not called one: a claim is one atomic
rename and a restart marks `interrupted` with no retry, so there is no receive
count and no poison-message loop, and nothing consumes the directory. It is bounded
by its own caps (7 days, 100 entries, **drop-oldest**) rather than by a payload
exception - dead-lettering an overflow _with_ its payload would rebuild the
unbounded queue `maxLength` exists to prevent. Drop-oldest is honest here though it
was rejected for `queue/`: a record of loss is the one thing that may lose its
oldest record.

**Redrive is human-only and is a fresh acceptance.** `e trigger redrive <id>`
renames the entry back into `queue/`; it reuses **the payload and nothing else**,
so agent, base, prompt template, caps, `match` filters and the base check all come
from the _current_ declaration. "Fix the trigger, then redrive" is the entire use
case, and a faithful replay would reproduce the bug that killed it. Refused against
a deleted or disabled trigger, and refused when the key is already back in
`queue/`. `dead/` is never consulted for dedup.

**The tick**, one `serve` interval of 30 s, in fixed order:

```
due triggers -> reconcile (start only) -> expire into dead/ -> sweep terminal
             -> sweep dead/ by age and count -> fill free slots
```

plus an immediate fill on enqueue, so a triggered run does not wait an interval on
an idle box. One timer means a slot is counted in exactly one place.

**Visibility**: pending and dead requests appear in `GET /api/runs` as `queued`
and `dead`, beside running ones - one list, one state machine. Hiding them makes
"did my webhook fire?" unanswerable. Metadata only; the list never carries a
payload body.

### 7. The webhook listener

`POST /hooks/<source>` on a **dedicated HTTP server at BFF port + 2**, not a route
on the BFF. `serve` already reserves a port block of 2 (the embed proxy at +1);
that block becomes 3.

This is a security boundary, not tidiness. A webhook must be reachable from the
internet, and the only way a loopback-bound `serve` gets that is a tunnel - and a
tunnel aimed at the BFF port publishes the whole BFF, including
`POST /api/terminal/sessions`, which starts a run with full repo write access, and
`POST /api/runs/<branch>/siblings`, neither of which is authenticated on any
interface (open ticket 70). A separate port means the tunnel cannot reach any of
it. A path-scoped tunnel was rejected because it puts the boundary in a third
party's config file, and misconfiguration is a named actor in this repo's threat
model.

**HMAC over the raw body is the whole authentication**, mandatory on every
interface, loopback included. ADR-0015 exempts loopback for A2A because anyone on
loopback could type `e spawn`; **a tunnel delivers an internet request on loopback**,
so the peer address stops saying anything. Verification happens over the raw bytes
before any parse, with a constant-time compare. An **empty signature header is a
mismatch, not an absence** - Gitea and Forgejo emit the headers even with no secret
configured. A mismatch answers 401 and is logged; a silent 404 was rejected,
because the URL is not a secret and "that endpoint does not exist" is false and
undiagnosable.

**The secret is `E_WEBHOOK_SECRET_<SOURCE>` in the serving Store's `.e/.env`**,
read host-side at verification time, one per source (a shared endpoint verifies
before it knows which trigger matches). Not in `trigger.json`, which goes into
git; not in `process.env`, which a detached restart from another terminal would
lose. It is not in `baseEnvWhitelist`, so it never reaches a container. **With no
secret configured the port does not open at all**, with a startup warning in the
voice of today's `A2A endpoint disabled: ...`; a closed port is unambiguous where
a 503 invites a retry. Inherited exposure, stated plainly: open ticket 72 - every
writer uses plain `writeFileSync`, so under umask 022 `.e/.env` lands 0644.

**Always accept and queue.** Gitea and Forgejo time out at 5 s, GitHub and
GitLab.com at 10 s, and a run is minutes. Worse, **no forge retries
automatically**: a delivery lost to a slow or absent listener is lost for good, and
the only recovery is a human clicking Redeliver. "Answer fast, reject rarely" is a
correctness requirement.

| Case                                             | Code                                  |
| ------------------------------------------------ | ------------------------------------- |
| Accepted, one or more triggers                   | 202                                   |
| Partially accepted (queue filled during fan-out) | 202, rejected triggers carry a reason |
| No trigger matched                               | **200**                               |
| Every matching trigger deduped                   | 200                                   |
| Queue full, nothing accepted                     | 429                                   |
| Signature wrong, or empty                        | 401                                   |
| Payload over 5 MB                                | 413                                   |
| Unknown `<source>`, wrong method, malformed JSON | 404 / 405 / 400                       |

The split between 200 and 429 is load-bearing: **GitLab disables a webhook after 4
consecutive non-2xx responses**. A no-match is your own configuration and must not
switch the webhook off; a full queue is real backpressure, where retry logic
conventionally lives. A partial acceptance answers 202, because a 429 would be a
lie the moment one run was accepted. Every rejection logs the event name, the
delivery id and the reason, and **never the payload**.

**Payload cap 5 MB**, not `/a2a`'s 1 MB: GitHub permits up to 2048 commits in a
`push`, which can exceed 1 MB, and the event would then be dropped by us rather
than by the forge. The cap bounds `/run/e/event.json`.

**Dedup is checked against `queue/` only**, never `live/` - which falls out of the
mechanism, since the key is the filename and the claim renames it away. So a
deliberate redelivery after the run started **re-runs**, which is what the
Redeliver button is for. Checking `live/` too would make that button inert for the
whole retention window.

**One delivery fans out to N triggers, N runs**, each with its own dedup key;
three matching triggers against two free slots means two accepted and one
rejected, reported per trigger in the 202.

**Unreviewed code is kept out by a rule on `base`, not on the event.** Rejecting
fork-originated events does not hold up: `pull_request` carries
`head.repo.full_name`, but `issue_comment` on a fork's PR does not carry it at
all, so a rule keyed on the event type has a hole. What decides the danger is
whether the worktree contains unreviewed code, and that is decided solely by
`base`. **The resolved `base` must be a ref in the target repository itself**, and
`refs/pull/*` is refused explicitly. A fork's head ref drops out by construction;
a `base` that does not resolve drops the event with a clear message rather than
failing later as a confusing checkout error. What this does not cover is prompt
injection out of a comment body, an explicit non-goal of this repo's threat model
and already narrowed by keeping prose out of the prompt.

**GitHub only in v1.** `source` is a validated enum so a second forge is a new
branch rather than a redesign. The other three are not free: GitLab gained HMAC
only in 19.0 and signs `{webhook-id}.{webhook-timestamp}.{body}` base64 with a
`v1,` prefix; Gitea and Forgejo sign the raw body hex without a prefix, and mint a
**new** UUID on replay, so there the delivery id cannot identify a duplicate at
all.

### 8. Cron

A cron trigger is an ordinary trigger whose event source is the clock.

```jsonc
"on": { "type": "cron", "expr": "0 3 * * *", "tz": "Europe/Berlin" }
```

**5 fields plus the `@`-aliases**; no seconds field, which would promise a
precision the 30 s tick cannot honour. **`tz` defaults to UTC**, not the host
zone: `e serve --detached` inherits the shell that started it, and a host-zone
default would make a schedule depend on which terminal launched the daemon.

**Missed ticks are discarded, never caught up.** Cron here means "at this time",
not "n times per day". Catch-up needs a durable `lastFiredAt` - the one piece of
state whose disagreement with reality is unfixable - and a week of downtime would
flush seven runs into a two-slot queue, all from a base that has moved on. The
scheduler is therefore **stateless across restarts**: each trigger's `nextRun` is
computed from `now`, which is also what makes a laptop suspend and a clock jump
harmless. DST follows: the spring gap simply has no matching instant, and the
autumn hour is not replayed because `nextRun` moves forward monotonically.

**Scheduling is a new first step in the existing `serve` tick**, every 30 s - no
per-trigger timers, which would fire late without knowing it after a suspend and
would be a second place to count slots. Cost: up to 30 s of latency on the minute.
**`croner@10`** is a dependency used **only** as the next-run calculator. Unlike
the queue libraries rejected in section 6, what it does is genuinely hard to write
twice - DST-correct "next occurrence in Europe/Berlin" - and it has zero
dependencies and ships ESM and CJS, clearing the `pkg --sea` bar. The scheduling
loop stays ours.

The dedup value is the **scheduled** time, minute-granular, UTC, compact:
`nightly:20260918T0300Z`. Scheduled and not actual, because the tick may notice a
due trigger up to 30 s late and the key must not move with it.

**An invalid expression disables that one trigger**, logged at startup, and
`serve` starts normally. One typo must not take down the BFF, the webhook listener
and four healthy triggers, and a detached `serve` that refuses to start is the
least diagnosable failure this system can produce.

**Triggers reload per tick** by an mtime scan of `.e/triggers/`, so editing a
schedule takes effect within 30 s and no restart severs live runs from their
streaming.

**`GET /api/triggers` and `e trigger list`** cover all trigger types with `id`,
`enabled`, a summary of `on`, `nextFireAt` (null for non-cron), `lastFiredAt` and
`lastRequestId`. A trigger that has never fired is invisible in `GET /api/runs`,
which is precisely the "why is my schedule not running?" case. `lastFiredAt` is
in-memory since `serve` started, so after a restart it reads **unknown**, not
never - those are different diagnoses. The listing exposes prompts, agent names and
`repo` paths on the unauthenticated BFF and inherits ticket 70 unchanged; a second
auth model for a read-only listing, on the same port as an unauthenticated route
that starts runs, is not worth having.

**Supervision is the host's job.** If `serve` is not running, nothing fires and
nobody is told. `e` is not a process supervisor and has no notification sink; the
answer is a systemd user unit around a foreground `e serve`, documented rather than
generated. What the product contributes instead is diagnosability.

### 9. Provenance in git

Exactly two trailers, on **every commit `e` writes** in a triggered run -
checkpoint and merge-back commits included, because the trailer says _this commit
arose in this run_, not _the trigger wrote these lines_:

```
E-Trigger: nightly
E-Event: github:issue_comment.created:8e9a1c2d-....
```

`E-Event` is `<source>:<event>:<id>`; a tick reads `cron:tick:20260918T0300Z` and a
one-shot CI run reads `workflow:<workflow name>:<run id>`. Nothing else: the agent,
the base and the run counter are already in the branch name (ADR-0003), and the
request id is deliberately out, because the ledger drops terminal entries after
about an hour and the pointer would dangle almost immediately.

**The event id is the source's own identity, never the coarsened dedup value.**
A trigger may coarsen dedup onto a path; that is a coalescing policy, not a fact
about what happened, and following it would give every run against issue 42 the
same id.

**Siblings inherit both trailers unchanged** - the cause is the same, and this
matters precisely because a sibling whose merge conflicts keeps its branch pushed
and never reaches the parent (section 12).

**A manual `e spawn` gets no trailer.** Absence is the statement, and it makes
`git log --grep E-Trigger` mean exactly "machine-started".

**Injection is closed at the acceptance boundary, not at commit time.** The HMAC
signs the body, not the headers, so a delivery id containing a newline would forge
trailers. The listener validates it against `[A-Za-z0-9._:-]{1,64}` _before_ the
queue file is written and substitutes the queue entry's own ULID when it does not
match; the delivery is still accepted, because a rejected one is lost for good.
**The queue entry is therefore the carrier of provenance**: it holds the trigger
id and the validated event id, `runSpawn` receives them, and the commit-writing
code knows no sanitisation at all.

**The git port stays dumb** (ADR-0002): `commitAll(path, message)` is unchanged and
a pure core helper composes `subject\n\n<trailers>`. Because the values are already
validated, `git interpret-trailers` buys nothing and the rule stays unit-testable
without a repository.

**The PR** keeps its title rule and gains a fixed block before the prompt,
separated by `---`:

```
Trigger: nightly · github:issue_comment.created
Event: https://github.com/<owner>/<repo>/issues/42
Harness: codex 0.147.0
Verdict: verified (2/3 iterations)
Autonomous run - not reviewed by a human.
```

Built from validated identifiers and URLs derived from them, **never payload
prose**. A PR body is worse than a prompt in this respect because it is _rendered_:
prose there means @-mentions, markdown and quotes that look like someone said them.
The `Verdict` line appears only where verify is declared and carries the reason on
a bad end; the verdict and the "unreviewed" line apply to a manual run with verify
too, and only the trigger lines are absent there.

**Nothing in `e` parses the trailer in v1.** The runs index is built from
`for-each-ref` and sees only the branch tip's subject; identity stays
branch-derived. While a run is live, "why did this start" is answered by the
ledger; afterwards by the PR, and by `git log --grep`. Because nothing depends on
the grammar, it stays free to change.

### 10. Harness versions are pinned

Unattended correctness now depends on specific argv - `codex exec
--dangerously-bypass-approvals-and-sandbox`, `opencode run --auto`, `claude -p
--dangerously-skip-permissions` - and `renderDockerfile` runs
`npm install -g <package>`, so every rebuild adopts whatever is latest.

**Exact pins in `HARNESSES`**, in the same object as the argv they protect, so the
flag and the version it was verified against travel in one reviewed diff. Never a
caret: a minor is what moved the Codex default. Delivered as `ARG` +
`--build-arg`, not rendered into the Dockerfile, because `e init` writes a Store's
Dockerfile once and never clobbers it, so a literal would reach only Stores created
afterwards.

**No build-time `--help` assertion.** A _removed_ flag already exits non-zero, and
non-zero is reliable on all four harnesses. The silent shape is the other one - the
flag survives and the **default beneath it moves**, exactly the read-only sandbox
that appeared under an unchanged `codex exec` - which no `--help` grep can see,
least of all opencode's hidden `--yolo` alias.

**What makes the pin bite**: `imageTag()` hashes nothing and `executeSpawn` builds
only what is missing, so a bumped pin would otherwise be a commit no running Store
ever sees. The image carries two labels (harness package and version, skills CLI
version); the host compares label against pin and rebuilds on mismatch - on the
**derived agent image** as well as the base, which inherits the labels and would
otherwise leave exactly the autonomous agents outside the pin. The rebuild is
announced and happens before the worktree exists (ADR-0005), so it runs against
none of section 4's budgets. Aborting and demanding `--rebuild` was rejected: a
cron trigger has nobody to retype it, and the run would die on its own safety net.
A pre-existing unlabelled image gets **one** rebuild attempt, then a hard abort
naming `e init --force`; never a loop, never a silent pass.

**Bumping** is Renovate with a `customManager` over the registry file and **no
automerge** - a bot that bumps and merges is `latest` with extra steps, adopting
precisely the defaults the pin exists to hold. A bump is gated by this checklist,
because a pin asserts "this version was verified against these flags":

- [ ] Run the harness's own `--help` and confirm every flag in `HARNESSES` still parses.
- [ ] Confirm the approval/sandbox **default** beneath those flags has not moved (for Codex: that the sandbox is bypassed, not read-only).
- [ ] Run one real unattended run against a scratch repo and confirm the worktree changed.
- [ ] Confirm a refusal still exits 0 (the liveness assumption in section 1).

`node:lts-alpine` and the skill _collections_ stay unpinned deliberately: security
patches should reach the image that runs foreign agent code without waiting for a
bump, a Node LTS jump breaks loudly at build time or not at all, and skill content
is soft drift. The skills **CLI** is pinned, being build tooling.

### 11. Gate integrity: `gateRemovals`, and no judge in v1

The loop rewards exactly one attack: deleting or loosening what verify measures
turns the verdict green _honestly by exit code_. The damage is not bad code - the
human at the PR sees that, and autonomy ends at an open PR - it is the **false
claim** section 9 makes `e` publish. A judge agent defends that claim poorly, being
itself an ungated agent that can hallucinate approval, leaving two unbacked claims
where there was one.

The cheap, verifiable answer instead:

- **`verify.guards`**, git pathspecs declared in the **Store**, never in the repo -
  a detector living in the worktree is one the agent can weaken before weakening
  what it guards. Default: a built-in test-path list (`**/*.test.*`, `*_test.*`,
  `test/`, `tests/`, `spec/`, `__tests__/`). Pathspecs rather than globs because
  git evaluates them itself and `e` carries no glob library.
- **Measured once per run** as `git diff --numstat <base>..<tip>` over the run
  branch - exactly what the PR contains, merged sibling work included. Not per
  iteration: an agent that deletes a test in iteration 1 and restores it in
  iteration 3 has weakened nothing. **Rename detection stays on** (git's default),
  probed rather than assumed: a `git mv` out of the guarded set still reads as a
  full removal because the pathspec matches the source, while `--no-renames` would
  falsely accuse a legitimate in-set rename.
- **`gateRemovals: { files, lines }`** - numbers, no boolean, because a boolean is
  what downstream code branches on and a heuristic that is branched on is a gate
  after all. Present whenever `verify` is declared, `0/0` included, so absence
  means exactly "no gate".

It qualifies **one word** in the PR block - `verified (gate weakened: 2 files, -47
lines)` - keyed on removals and never on touches, since adding tests touches the
same files. No fifth exit code, no veto, no effect on the loop. Where the verdict
is not `verified` there is no claim to qualify and no sentence is rendered, though
the numbers are still recorded.

**Human-facing surfaces only**: the PR block, the web UI, `GET /api/runs`, the run
report. Explicitly **not** the sibling report, which an agent reads inside the
worktree, not the A2A task, which an agent consumes over HTTP, and not the
iteration feedback - a counted signal handed to an agent teaches laundering
(rename it, move it, weaken an assertion instead of deleting a line), symmetric to
withholding the countdown.

**Accepted limit**: this counts removed lines, not weakened semantics.
`expect(x).toBe(3)` becoming `expect(x).toBeDefined()` registers as `1/1`;
`if (process.env.CI) return;` added to a test body is `+1/-0` and is invisible. It
is a cheap, honest, non-authoritative smell, not a gate. Anything stronger was the
judge.

### 12. Siblings without a human

Nothing replaces the wait, because the wait was never on a human: the parent
**agent** was always the only party who could resolve a merge-back, and it always
had one turn. What autonomy exposes is that the host's fallback was dishonest - the
run-end `commitAll` concluded a merge with `MERGE_HEAD` still set, shipping
`<<<<<<<` markers to an open PR as a green run, with a "check for leftover conflict
markers" reason nobody autonomous will read. Four fixes, all unconditional, because
each is a bug in its own right that autonomy merely makes unsurvivable:

1. **The host never concludes a merge it did not resolve.** Before the run-end
   commit, an in-progress merge is `git merge --abort`ed; the sibling becomes
   `skipped` and the parent's own work is committed cleanly on top. ADR-0013 says
   the host never resolves a conflict, and silently committing markers _is_
   resolving it, badly.
2. **`input-required` may not outlive the run.** `taskStateOf` is unchanged -
   mapping `conflict`/`held` to `input-required` is accurate while the parent is
   alive, because the parent is the input source. The invariant is enforced in
   `finish()`: **after a run ends, none of its siblings are `input-required`.**
   This holds for interactive runs too, where a terminal `input-required` was
   always a task nobody was going to answer.
3. **The report keeps its instruction and loses its false promise.** One report for
   both modes, because a parent agent cannot verify which mode it is in. The
   `conflict` tail now reads: until you resolve it no other sibling can be merged
   and you cannot spawn another; if your run ends unresolved, the host abandons the
   merge and the sibling's branch keeps its work. Strictly more motivating than
   "resolve it or the host commits your markers for you".
4. **The parent pushes what did not reach it.** `!params.sibling` guarded the push
   on the assumption that a sibling's work arrives by merge-back; now that "not
   merged" is routine, that assumption is gone, and the work would survive only as
   a local branch on whichever host ran `e serve`. The sibling's run ends before the
   parent decides its merge outcome, so the parent does it in `finish()`, for every
   sibling whose final status is not `merged`/`up-to-date`. A failed sibling
   committed nothing, so `hasCommitsBeyondBase` makes it a no-op.

**The spawn-time refusal survives unchanged.** At spawn time the agent is mid-turn
and may be one edit from resolving, so an auto-abort would destroy a resolution in
progress; at run end the agent is out of moves and aborting costs nothing. An agent
that ignores the refusal forever merely ends the run, and the run-end abort catches
it.

### 13. Supported deployments

Deployment is the operator's choice, so the contract names two shapes. A CI runner
is a place to **run** `e`, not a new way to **reach** it: a GitHub-hosted runner
sits on GitHub's side of the internet, so a workflow calling out needs the same
public address a webhook needs. Direction buys nothing.

|                                | **hosted**                        | **one-shot**                                                    |
| ------------------------------ | --------------------------------- | --------------------------------------------------------------- |
| What runs                      | `e serve`, long-lived             | `e spawn --trigger <name> [--event <path>]`, one process        |
| Started by                     | cron tick, webhook delivery       | whatever surrounds it: a CI job, a systemd timer, a k8s CronJob |
| Scheduling, dedup, concurrency | `e` owns them (`queue/`, `live/`) | the outer scheduler owns them                                   |
| Loop, verify, caps             | `e` owns them                     | identical: they live in `runSpawn`, not in `serve`              |

**One declaration serves both.** On Actions, `--event "$GITHUB_EVENT_PATH"` hands
`e` exactly the payload the listener would have received, so section 5's filtering
and identifier-only interpolation apply unchanged - whereas a prompt written into
workflow YAML would let `${{ github.event.issue.body }}` be interpolated _outside_
`e`, where no rule of ours reaches. `--event` is optional, because
`$GITHUB_EVENT_PATH` is an Actions gift and no other CI exposes a payload file; a
trigger whose prompt or `base` references payload paths then fails at load with a
clear message rather than rendering an empty string. `on`/`match` are still
evaluated when a payload is present - one trigger file must not mean two different
things depending on who read it - and a non-match starts no run and **exits 0**,
since the exit codes describe a run's verdict and here no run existed. A cron
trigger runs one-shot with `expr`/`tz` ignored and a warning.

**The base rule extends from the worktree to the declaration.** In a
`pull_request` job the workflow file comes from the base, but every other file
comes from the head - `trigger.json` included. So the trigger is read from `base`
(`git show <base>:.e/triggers/<name>/trigger.json`), never from the working tree.
Documenting "do not run one-shot triggers on untrusted PRs" was rejected as a
footnote the first fork PR would disprove.

**Void in one-shot**: the queue and slot accounting, dedup, the `live/` ledger,
`nextFireAt`/`lastFiredAt`, `GET /api/runs`, A2A cancel. Siblings and the
runtime-broker still work, being per-run rather than per-`serve` (ADR-0013).

**Operational requirements**, to be documented with the snippet:

- `actions/checkout` defaults to `fetch-depth: 1`, so the base ref is frequently
  absent; the snippet specifies `fetch-depth: 0`, and a base that does not resolve
  errors as a base error rather than a confusing checkout failure.
- `loop.totalTimeoutMs` (3 h default) must sit under the job timeout
  (GitHub-hosted: 360 min default, 6 h cap). The exit codes become the job's
  status, so an exhausted run is already a red job.
- Secrets travel by the existing `--env-file`, pointed at a file the pipeline
  writes outside the checkout (`$RUNNER_TEMP`). Not `process.env` passthrough,
  which retires the invariant that `.e/.env` is the sole secret source (ADR-0006);
  not `-e KEY=value`, which is visible in the process list and in pipeline logs.
- A **committed `.e/`** is the recommendation, so the trigger, agent, verify
  command and caps are reviewed through PRs like any other code. Worth saying
  plainly: `e`'s own repo gitignores `.e/`, so adopting one-shot is a deliberate
  act.

**No GitHub Action is shipped in v1** - only a tutorial snippet and this section.
`e` must not assume Actions; a shipped action is a second release artifact with its
own version surface, and per section 10 we would be pinning the pinner.

## Relationship to ADR-0003 and ADR-0013

**ADR-0003 (run identity and ledger is branch-shaped) is upheld.** That ADR
rejected a managed index "for now" and said explicitly that "if the orchestrator
later needs live status/timing/logs, such an index can layer on top without
changing how identity and counting work". `.e/runs/live/` is exactly that layer and
nothing more:

- Run **identity** stays branch-derived. A ledger entry's `run` field holds the
  branch name and is null until the claim; the request id `trg-<ulid>` names the
  request, never the run.
- **Counting** stays `nextRunName` over git refs. Nothing in the queue or the
  ledger enumerates runs.
- The ledger holds **live and pending runs only**, sweeping terminal entries after
  about an hour. History remains branch + PR + the section 9 trailer. `dead/` holds
  requests that never became a run, so it duplicates no branch either.

**ADR-0013 (nested spawn) is upheld, and its central rule is strengthened.** The
host still never resolves a merge conflict: where it previously committed through
an in-progress merge at run end, it now aborts (section 12). An unmergeable sibling
is **dropped, not fixed** - its branch is pushed with its work intact and the
merge is abandoned. Depth 2, the fan-out cap, the checkpoint and the spool are all
unchanged, and siblings work in both deployment shapes.

## Consequences

- **`exitCode` changes meaning.** For a looping run it is the run's verdict, not
  the harness's, and it gains the value `2`. Every caller that reads it must be
  reviewed; per-iteration harness codes survive in `iterations`.
- **The `exitCode === 0` gates on commit and push must go** (`runSpawn.ts:499`,
  `runSpawn.ts:521-529`): an exhausted run exits `2` and still has to push its
  branch.
- **`readConfig` takes one root today** and must learn the target-repo /
  serving-Store / defaults chain of section 5, and `resolveConfig` gains its first
  nested resolvers plus the two new failure cases "block absent" and "block is not
  an object".
- **`serve`'s port block grows from 2 to 3.**
- **The `ContainerRunner` port gains `runCaptured`.** The gate's output is what
  the next attempt is told, and a stream that only reached the terminal is gone
  by then. It is a second method rather than an option on `run`, because every
  other caller wants the engine to own the terminal and nobody else wants the
  buffer; it tees each chunk onward, so a human still watches the check live.
- **The `Git` port gains a numstat method.** It has no diff surface at all today
  (`runLog` only); the addition is host-side, under ADR-0002.
- **Two new dependencies**, both cleared against `pkg --sea`: `ulid` (monotonic
  request ids; `crypto.randomUUID({version:7})` silently ignores the option on
  Node 24.15 and returns v4) and `croner@10` (next-run calculation only).
- **A new Store surface**: `.e/triggers/<name>/`, `.e/runs/{queue,live,dead}/`, and
  the `verify` / `resources` / `loop` / `dead` blocks in `config.json`. Triggers
  travel with `e export` / `e import`; `.e/runs/` does not.
- **New CLI and API surface**: `e trigger list`, `e trigger dead`,
  `e trigger redrive <id>`, `e spawn --trigger <name> [--event <path>]`,
  `GET /api/triggers`, and the `queued` / `dead` states in `GET /api/runs`.
- **Ticket 70 (BFF auth beyond loopback)** stops being a prerequisite once the
  listener has its own port, but `GET /api/triggers` inherits its exposure.
  **Ticket 72 (`.e/.env` 0600)** now has the webhook secret riding on it.
  **Ticket 153** remains an open prerequisite for anything that would widen `base`
  beyond the target repository's own refs.
- **A latent hazard is named, not fixed**: the existing sibling artifact sync
  copies host-built, glibc-linked trees into musl containers. Verify sidesteps it
  by installing its own dependencies; the sync itself is untouched.

## Planned for v2

**A judge agent as a second gate.** Committed to, and documented here because the
repo has no roadmap surface.

- **Scope**: gate integrity - the case `gateRemovals` can smell but never prove.
- **Cadence**: one call **per run**, never per iteration, which would pay full
  price on every red pass and mostly judge unfinished code.
- **Carrier**: the existing Remote-agent A2A path
  (`src/engine/a2a/remoteCall.ts`). The host already speaks A2A in-process and gets
  an answer string back, with no worktree, branch or merge-back, so a judge costs
  no run machinery.
- **Open**: what the judge sees (diff, prompt, verify output, iteration history),
  what a red judgement actually gates, and what stops a hallucinated approval from
  becoming a third unbacked claim.

Also deferred: per-pipeline snippets and a `pipeline` trigger source for GitLab CI,
Jenkins, Woodpecker and Drone; `serve` polling a forge instead of being called, the
one path needing no inbound reachability; a real per-harness smoke run in CI as the
bump gate of section 10, blocked on four provider accounts and their keys reaching
CI; and an outer-deadline signal (`E_DEADLINE_AT`) that would shrink the caps to fit
a CI job's own timeout.

## Out of scope

- **Token and cost budgets**: `e` never sees token usage, only the provider does.
- **The host as a planner** that decomposes work and assigns siblings. A different
  product.
- **Autonomous merge-conflict resolution**: contradicts ADR-0013.
- **A filesystem watcher** as a trigger source.
- **Auto-merging a PR**, green gate or not. Autonomy ends at an open PR.
