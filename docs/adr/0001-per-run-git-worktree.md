# Runs execute in an isolated per-run git worktree

Each run gets its own git worktree on a new branch, created on the **host** and
bind-mounted into the harness container at `/workspace`, never the user's
working directory in place. The worktree is branched from local **HEAD**
(committed state only; uncommitted edits in the main tree do not carry over).
A git repository is **required**: spawning outside one is an error, not a
fallback. When the agent exits, `e` commits any leftover uncommitted changes
(otherwise it leaves the agent's own commits), then **removes the worktree but
keeps the branch**: the branch is the durable artifact, the checkout is
disposable scaffolding.

## Considered Options

- **In-place bind mount of the working directory** (the original behavior),
  rejected: no isolation (an agent mutates the real tree), and two runs on one
  directory collide.
- **Copy-in / diff-out** and **ephemeral in-container clone**, rejected:
  heavier, and neither yields the natural per-run branch/diff a worktree gives.

## Consequences

- A run's output is always "the commits on `e/<harness>/<slug>-N`", reviewable
  and mergeable with ordinary git.
- Only git-ignored files (e.g. `node_modules`, build output, `.env`) are lost
  when the worktree is dropped; tracked and newly-added files are committed
  first.
