import type { PullRequest } from '../github/index.js';
import { GitPlatform } from '../store/config.js';

/** Clean seam for PR/MR management in runs. */
export interface PullRequestManager {
  /** Create a pull request/merge request. */
  create(params: {
    platform: GitPlatform;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ url: string; warning?: string }>;
}

/** Production PR manager using actual GitHub/GitLab clients. */
export class ProductionPullRequestManager implements PullRequestManager {
  constructor(private readonly pullRequest: PullRequest) {}

  async create(params: {
    platform: GitPlatform;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ url: string; warning?: string }> {
    try {
      const url = this.pullRequest.create({
        platform: params.platform,
        head: params.head,
        base: params.base,
        title: params.title,
        body: params.body,
      });
      return { url };
    } catch (error) {
      return {
        url: '',
        warning: `could not open a ${params.platform} merge request for ${params.head}: ${(error as Error).message}`,
      };
    }
  }
}
