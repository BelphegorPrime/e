import { spawnSync } from 'child_process';
import type { PullRequest, PullRequestSpec } from './index.js';
import type { GitPlatform } from '../store/config.js';
import { log } from '../utils/log.js';

/**
 * The real `PullRequest` port: shells out to the platform's native CLI in the
 * host process (`gh` for GitHub, `glab` for GitLab; the GitHub-compatible
 * Forgejo/Gitea use `gh`, whose auth config maps the repo's remote host).
 * Every call throws on non-zero exit so the orchestrator can surface the
 * failure non-fatally.
 */
export class HostPullRequest implements PullRequest {
  create(spec: PullRequestSpec): string {
    const args = this.args(spec);
    const cli = this.cli(spec.platform);
    const out = this.capture(
      [cli, ...args],
      `open ${spec.platform} merge request for ${spec.head}`
    );
    // The platform CLIs print the PR/MR URL on stdout; tolerate banners and
    // git noise around it by scanning for a URL anywhere in the output.
    const match = /https?:\/\/\S+/.exec(out);
    return match ? match[0] : '';
  }

  /** The subcommand argv for a platform, starting after the CLI binary name. */
  private args(spec: PullRequestSpec): string[] {
    if (spec.platform === 'gitlab') {
      return [
        'mr',
        'create',
        '--source-branch',
        spec.head,
        '--target-branch',
        spec.base,
        '--title',
        spec.title,
        '--description',
        spec.body,
      ];
    }
    // GitHub, and the GitHub-compatible Forgejo/Gitea: `gh` resolves the repo's
    // host from the git remote against its own authenticated-host config, so a
    // user on a self-hosted instance needs only `gh auth login --hostname <host>`
    // — no hostname is baked into the invocation here.
    return [
      'pr',
      'create',
      '--head',
      spec.head,
      '--base',
      spec.base,
      '--title',
      spec.title,
      '--body',
      spec.body,
    ];
  }

  /** The native CLI binary for the platform. */
  private cli(platform: GitPlatform): string {
    return platform === 'gitlab' ? 'glab' : 'gh';
  }

  /** Runs a CLI subcommand and returns its stdout, throwing on failure. */
  private capture(args: string[], description: string): string {
    const result = spawnSync(args[0], args.slice(1), {
      encoding: 'utf8',
      shell: false,
    });
    if (result.error) {
      throw new Error(
        `Failed to start ${args[0]} (${description}): ${result.error.message}`
      );
    }
    if (result.status !== 0) {
      const detail =
        result.stderr?.trim() || result.stdout?.trim() || '';
      throw new Error(`${args[0]} failed (${description}): ${detail}`);
    }
    log.command(description);
    return result.stdout;
  }
}
