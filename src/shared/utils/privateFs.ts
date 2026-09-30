import fs from 'node:fs';
import path from 'node:path';

/**
 * **Host-only files under the Store**: the session of a Run (ADR-0017) and
 * the record of a Fusion run (ADR-0019) hold transcripts, prompts and
 * patches, so they are the host user's alone - directories 0700, files 0600
 * from the first byte - and a partly committed Store never commits them.
 */

/** A 0700 directory, whatever the umask made of it. */
export function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Writes `content` to `file`, 0600: temp + rename, so a reader sees all of it or nothing. */
export function writePrivateFileAtomic(
  file: string,
  content: string | Buffer
): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** A private directory that git ignores entirely, for a Store that is partly committed. */
export function privateIgnoredDir(dir: string): void {
  privateDir(dir);
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) writePrivateFileAtomic(ignore, '*\n');
}
