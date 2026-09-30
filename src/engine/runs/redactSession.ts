/**
 * **Secrets out of a kept session** (#205, ADR-0017): every harness records
 * tool output in its session, and the session outlives the run in the
 * Store. The agent's shell inherits the key it was given - pi and opencode
 * have no setting that hides it - so an `env`, a `printenv` or an error that
 * echoes a variable writes the value into the transcript. The host knows
 * every value it delivered, so when the run ends it masks them in the
 * session dir before the session is kept.
 *
 * A value is masked with `*` of the same length, which keeps every file's
 * shape: a JSONL line still parses, a SQLite page keeps its record lengths.
 * A SQLite database (opencode's `opencode.db`) is masked through SQL rather
 * than bytes - with `secure_delete` on, so a freed page is zeroed, and its
 * WAL checkpointed into the file, whose frames carry checksums a byte edit
 * would break - and then swept like any other file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { errorMessage } from '../../shared/utils/errors.js';
import { log } from '../../shared/utils/log.js';

/**
 * The shortest value treated as a secret. Shorter ones (`1`, `true`, a port)
 * would mask ordinary text all over the transcript; no API key is that short.
 */
export const MIN_SECRET_LENGTH = 8;

/** The first bytes of every SQLite 3 database file. */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/** Files SQLite owns beside a database, handled by opening the database. */
const SQLITE_SIDE_FILE = /-(wal|shm|journal)$/;

/**
 * The values to mask: unique, at least {@link MIN_SECRET_LENGTH} long, and
 * longest first, so a value that contains another is masked whole.
 */
export function secretsToRedact(
  values: Iterable<string | undefined>
): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (value !== undefined && value.length >= MIN_SECRET_LENGTH) {
      unique.add(value);
    }
  }
  return [...unique].sort((a, b) => b.length - a.length);
}

/** `value`'s mask: `*` of the same byte length. */
function maskOf(value: Buffer): Buffer {
  return Buffer.alloc(value.length, '*');
}

/** Masks every occurrence of `secrets` in `buffer` in place; returns how many. */
function maskBuffer(buffer: Buffer, secrets: readonly Buffer[]): number {
  let count = 0;
  for (const secret of secrets) {
    const mask = maskOf(secret);
    for (
      let at = buffer.indexOf(secret);
      at !== -1;
      at = buffer.indexOf(secret, at + secret.length)
    ) {
      mask.copy(buffer, at);
      count += 1;
    }
  }
  return count;
}

/** True when `file` starts like a SQLite database. */
function isSqlite(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(SQLITE_MAGIC.length);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return read === head.length && head.equals(SQLITE_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** A SQL identifier, quoted. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Masks the secrets in every text value of every table, then checkpoints the
 * WAL into the file and truncates it. Returns the rows changed.
 */
function redactSqlite(file: string, secrets: readonly string[]): number {
  const db = new DatabaseSync(file);
  let changed = 0;
  try {
    db.exec('PRAGMA secure_delete = ON');
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as { name: string }[];
    for (const { name: table } of tables) {
      const columns = db
        .prepare(`PRAGMA table_info(${ident(table)})`)
        .all() as { name: string }[];
      for (const { name: column } of columns) {
        const col = ident(column);
        const update = db.prepare(
          `UPDATE ${ident(table)} SET ${col} = replace(${col}, ?, ?) WHERE typeof(${col}) = 'text' AND instr(${col}, ?) > 0`
        );
        for (const secret of secrets) {
          changed += Number(
            update.run(secret, '*'.repeat(secret.length), secret).changes
          );
        }
      }
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  return changed;
}

/** Every regular file under `dir`, depth first. */
function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name));
}

/**
 * Masks every occurrence of `secrets` under `dir` and returns how many it
 * masked (rows, for a database). Best-effort per file: one that cannot be
 * read or written is warned about and left, never a failed run.
 */
export function redactSessionDir(
  dir: string,
  secrets: readonly string[]
): number {
  if (secrets.length === 0 || !fs.existsSync(dir)) return 0;
  const buffers = secrets.map(secret => Buffer.from(secret, 'utf8'));
  let count = 0;
  const files = filesUnder(dir);
  // Databases first: their WAL is checkpointed before the byte sweep.
  for (const file of files.filter(isSqlite)) {
    try {
      count += redactSqlite(file, secrets);
    } catch (err) {
      log.warn(
        `Could not redact the session database ${file}: ${errorMessage(err)}`
      );
    }
  }
  for (const file of filesUnder(dir)) {
    if (SQLITE_SIDE_FILE.test(file)) continue;
    try {
      const content = fs.readFileSync(file);
      const masked = maskBuffer(content, buffers);
      if (masked > 0) {
        fs.writeFileSync(file, content);
        count += masked;
      }
    } catch (err) {
      log.warn(
        `Could not redact the session file ${file}: ${errorMessage(err)}`
      );
    }
  }
  return count;
}
