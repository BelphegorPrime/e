import type { Git } from './git/index.js';
import type { PullRequest, GitPlatform } from './store/config.js';

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
  constructor(private readonly git: Git, private readonly pullRequest: PullRequest) {}

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
        warning: `could not open a ${params.platform} merge request for ${params.head}: ${(error as Error).message}`,      };
    }
  }
}

/** In-memory PR manager for testing. */
export class InMemoryPullRequestManager implements PullRequestManager {
  async create(params: {
    platform: GitPlatform;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ url: string; warning?: string }> {
    // Simulate PR creation for testing
    return {
      url: `https://example.com/${params.platform}/${params.head}`,
    };
  }
}

/** Resource cleanup manager for temporary files and directories. */
export interface ResourceCleanupManager {
  /** Create a temporary directory for build context. */
  createTempDir(): string;
  /** Write content as a file with proper permissions. */
  writeFile(fileName: string, content: string, opts?: { mode?: number }): string;
  /** Clean up all tracked resources. */
  cleanup(): void;
}

/** Production resource cleanup using actual file system. */
export class FileSystemResourceCleanupManager implements ResourceCleanupManager {
  private tempDirs: string[] = [];

  createTempDir(): string {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-scratch-'));
    this.tempDirs.push(tempDir);
    return tempDir;
  }

  writeFile(fileName: string, content: string, opts?: { mode?: number }): string {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(this.createTempDir(), fileName);
    const mode = opts?.mode ?? 0o600;
    fs.writeFileSync(filePath, content, { mode });
    return filePath;
  }

  cleanup(): void {
    const fs = require('fs');
    for (const dir of this.tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        // Ignore cleanup errors in production
      }
    }
    this.tempDirs = [];
  }
}

/** In-memory resource cleanup for testing. */
export class InMemoryResourceCleanupManager implements ResourceCleanupManager {
  private tempDirs: string[] = [];

  createTempDir(): string {
    const tempDir = `temp-${this.tempDirs.length}`;
    this.tempDirs.push(tempDir);
    return tempDir;
  }

  writeFile(fileName: string, content: string, opts?: { mode?: number }): string {
    return `${this.createTempDir()}/${fileName}`;
  }

  cleanup(): void {
    this.tempDirs = [];
  }
}