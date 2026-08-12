import fs from 'fs';

/**
 * Scaffolding writes shared by everything that renders e's on-disk state from a
 * declaration — harness Dockerfiles and default agents (`e init`), and the
 * derived agent config/Dockerfile (`e spawn`). The invariant is the same across
 * all of them: **render, but never clobber a hand edit.** A file that already
 * exists is left exactly as the user left it; a divergence is shown as a diff so
 * they can reconcile it themselves.
 */

/**
 * Writes `content` to `file` (creating `dir`), but never overwrites an existing
 * file: if it matches it's reported up-to-date, and if it differs the change is
 * shown as a line diff so the user can reconcile a hand-edited file themselves.
 */
export function writeIfAbsent(
  dir: string,
  file: string,
  content: string
): void {
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, content);
    console.log(`wrote ${file}`);
    return;
  }

  const existing = fs.readFileSync(file, 'utf8');
  if (existing === content) {
    console.log(`up to date ${file}`);
    return;
  }

  console.log(`changed ${file} (kept existing, not overwritten):`);
  for (const line of diffLines(existing, content)) {
    console.log(`  ${line}`);
  }
}

/**
 * Minimal line-based diff via a longest-common-subsequence. Returns lines
 * prefixed with `-` (only in the existing file), `+` (only in the newly
 * rendered content), or a space (unchanged).
 */
export function diffLines(existing: string, rendered: string): string[] {
  const a = existing.split('\n');
  const b = rendered.split('\n');
  const m = a.length;
  const n = b.length;

  // lcs[i][j] = length of the LCS of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < m) out.push(`- ${a[i++]}`);
  while (j < n) out.push(`+ ${b[j++]}`);
  return out;
}
