import type { GitPlatform } from '../store/config.js';

/**
 * Host-side merge-request creation a Run needs after a successful push.
 * Mirrors the `Git` port (src/git): the orchestrator (`runSpawn`) depends only
 * on this interface so it can be faked in tests, and the real CLI entry points
 * (`gh`, `glab`) stay in the host process - the container never sees the
 * credentials they carry (ADR-0002).
 */
export interface PullRequest {
  /**
   * Opens a PR/MR from `headBranch` into `baseBranch` on the configured
   * platform, with the run's prompt as the body. Throws on any failure (no
   * CLI, not authenticated, no upstream, rejected).
   * @returns the web URL of the created PR/MR.
   */
  create(spec: PullRequestSpec): string;
}

/** What a run needs to open its PR/MR. */
export interface PullRequestSpec {
  /** The git platform: `github`, `gitlab`, `forgejo`, or `gitea` (from config.json). */
  platform: GitPlatform;
  /** The run's branch (the head/source of the PR/MR). */
  head: string;
  /** The target branch the run was cut from (current branch when spawned). */
  base: string;
  /** The PR/MR title - the run's commit message. */
  title: string;
  /** The PR/MR body - the run's prompt / task description. */
  body: string;
}
