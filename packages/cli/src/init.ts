import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { renderDockerfile } from './harness/renderDockerfile';
import { renderEnvTemplate } from './harness/renderEnvTemplate';
import {
  HARNESSES,
  type Harness,
  envHarnessSections,
} from './harness/index';
import { renderDefaultAgent } from './agent';
import {
  dockerfilePath,
  harnessDir,
  harnessesBaseDir,
  envFilePath,
  agentDir,
  agentFilePath,
} from './store';

interface InitCommandOptions {
  dir?: string;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description(
      'Write the harness Dockerfiles so `spawn` can build their images',
    )
    .option(
      '--dir <path>',
      'root directory to write the harnesses into (default: home directory)',
    )
    .action((opts: InitCommandOptions) => {
      const root = opts.dir ? path.resolve(opts.dir) : undefined;

      for (const harness of Object.values(HARNESSES)) {
        writeDockerfile(harness, root);
        writeDefaultAgent(harness, root);
      }

      writeEnvFile(root);

      console.log(
        `\nInitialized ${Object.keys(HARNESSES).length} harnesses in ${harnessesBaseDir(root)}.`,
      );
      console.log('Run `e spawn <harness> <prompt>` to build and run one.');
    });
}

/**
 * Writes `content` to `file` (creating `dir`), but never overwrites an existing
 * file: if it matches it's reported up-to-date, and if it differs the change is
 * shown as a line diff so the user can reconcile a hand-edited file themselves.
 */
function writeIfAbsent(dir: string, file: string, content: string): void {
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

/** Writes a harness's Dockerfile (never overwriting a hand-edited one). */
function writeDockerfile(harness: Harness, root: string | undefined): void {
  writeIfAbsent(
    harnessDir(harness.name, root),
    dockerfilePath(harness.name, root),
    renderDockerfile(harness.dockerfile),
  );
}

/** Writes a harness's default agent definition (never overwriting a hand-edited one). */
function writeDefaultAgent(harness: Harness, root: string | undefined): void {
  writeIfAbsent(
    agentDir(harness.name, root),
    agentFilePath(harness.name, root),
    renderDefaultAgent(harness.name),
  );
}

/**
 * Minimal line-based diff via a longest-common-subsequence. Returns lines
 * prefixed with `-` (only in the existing file), `+` (only in the newly
 * rendered content), or a space (unchanged).
 */
function diffLines(existing: string, rendered: string): string[] {
  const a = existing.split('\n');
  const b = rendered.split('\n');
  const m = a.length;
  const n = b.length;

  // lcs[i][j] = length of the LCS of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
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

/**
 * Writes the shared `.env` base environment file, creating it from the template
 * when absent or, when it already exists, appending sections for any harnesses
 * not yet present so the user's filled-in values are preserved.
 */
function writeEnvFile(root: string | undefined): void {
  const file = envFilePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const sections = envHarnessSections();

  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, renderEnvTemplate({ harnesses: sections }));
    console.log(`wrote ${file}`);
    return;
  }

  const existing = fs.readFileSync(file, 'utf8');
  const missing = sections.filter(
    (section) => !existing.includes(`# --- ${section.name} ---`),
  );

  if (missing.length === 0) {
    console.log(`up to date ${file}`);
    return;
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  const appended = renderEnvTemplate({
    harnesses: missing,
    includeHeader: false,
  });
  fs.writeFileSync(file, existing + separator + appended);
  console.log(
    `updated ${file} (added sections: ${missing.map((s) => s.name).join(', ')})`,
  );
}
