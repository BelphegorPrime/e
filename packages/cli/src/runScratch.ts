import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Owns every throwaway host file and directory a single spawn creates — the MCP
 * and provider credential env-files (mode 0600), the Codex config overlay, and
 * the derived-image build context — so their whole lifecycle lives in one place
 * and a single {@link dispose} removes them all.
 *
 * Before this, the spawn edge threaded two separate cleanup registries and
 * called them by hand in every fail-fast path; forgetting one leaked a rendered
 * secret to a mode-0600 temp file. With one owner, any exit path can just
 * `dispose()` in a `finally`, and leak-by-omission is impossible.
 */
export class RunScratch {
  private readonly dirs: string[] = [];

  constructor(private readonly prefix: string = 'e-scratch-') {}

  /**
   * A fresh empty temp dir, tracked for disposal — used to assemble a build
   * context (rendered files plus copied trees) before handing it to the runtime.
   */
  dir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), this.prefix));
    this.dirs.push(dir);
    return dir;
  }

  /**
   * Materializes `content` as `fileName` inside a fresh tracked temp dir and
   * returns its host path. Defaults to mode 0600, because these files hold
   * resolved secrets (credential env-files); pass `mode` for a non-secret file.
   */
  file(fileName: string, content: string, opts?: { mode?: number }): string {
    const file = path.join(this.dir(), fileName);
    fs.writeFileSync(file, content, { mode: opts?.mode ?? 0o600 });
    return file;
  }

  /**
   * Removes every dir created here. Idempotent — safe to call in a `finally` and
   * again from an error path, so a spawn never has to reason about which files
   * it managed to create before it failed.
   */
  dispose(): void {
    for (const dir of this.dirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    this.dirs.length = 0;
  }
}
