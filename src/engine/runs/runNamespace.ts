/**
 * **The run namespace** (ADR-0003, #208): the repositories whose runs share
 * one Store's run names. The worktrees dir is one per host, and the
 * container and the session (`.e/runs/sessions/<run name>`) are keyed by the
 * run name alone, so a home Store that cuts runs in several repositories
 * counts a run's `N` past the runs of all of them, and `serve` lists them all.
 *
 * Two sources, because neither alone knows every repository: the `repo` each
 * trigger names, where a run may land before it ever ran, and the record a
 * run leaves of the repository it was cut in (`.e/runs/repos/`), which covers
 * a manual `e spawn`, the browser terminal and `serve`'s own repository.
 * The record is a set on the filesystem: one file per repository, named by
 * its path's hash and written temp + rename, so concurrent runs never lose
 * one and a reader never sees half of one.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eBaseDir } from '../../core/store/paths.js';
import { storeTriggerContext } from '../../core/trigger/context.js';
import { triggerRepositories } from '../../core/trigger/load.js';
import {
  readJson,
  writeJsonAtomic,
} from '../../sidecars/broker/contract/spool.js';
import { RUNS_DIR } from '../queue/runsSpool.js';

/** `.e/runs/repos/`: the repositories this Store's runs were cut in. */
export const REPOS_DIR = 'repos';

function reposDirFor(storeDir: string): string {
  return path.join(storeDir, RUNS_DIR, REPOS_DIR);
}

/** Records that a run of the Store at `storeDir` was cut in `repo` (idempotent). */
export function recordRunRepository(storeDir: string, repo: string): void {
  const resolved = path.resolve(repo);
  const dir = reposDirFor(storeDir);
  fs.mkdirSync(dir, { recursive: true });
  const name = crypto.createHash('sha256').update(resolved).digest('hex');
  writeJsonAtomic(path.join(dir, `${name.slice(0, 16)}.json`), {
    path: resolved,
  });
}

/** The repositories recorded for the Store at `storeDir`; a corrupt record reads as absent. */
export function recordedRunRepositories(storeDir: string): string[] {
  const dir = reposDirFor(storeDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .sort()
    .flatMap(file => {
      const record = readJson<{ path?: unknown }>(path.join(dir, file));
      return typeof record?.path === 'string' ? [record.path] : [];
    });
}

/** Every repository of the run namespace of the Store at `root`, deduplicated. */
export function runNamespace(root: string | undefined): string[] {
  if (root === undefined) return [];
  return [
    ...new Set([
      ...triggerRepositories(root, storeTriggerContext(root)),
      ...recordedRunRepositories(eBaseDir(root)),
    ]),
  ];
}
