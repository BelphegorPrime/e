/**
 * Shared parsing/filtering of `.env`-style file content. Previously lived in the
 * harness config adapter (its own seam-flavoured renderer stays there); these
 * two are general file-content utilities consumed by the spawn edge, init
 * planning, and the executor, so they live here next to the other utils.
 */

/**
 * Parses `.env`-style content into a key→value map, following docker's
 * `--env-file` basics: `KEY=VALUE` lines, `#` comment lines and blank lines
 * ignored, the value taken verbatim after the first `=` (no quote stripping).
 */
export function parseDotenv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === '') continue;
    env[key] = line.slice(eq + 1);
  }
  return env;
}

/**
 * Filters `.env`-style content down to `allowedKeys` only, re-serialized with
 * the last value winning for a duplicated key (docker's behaviour). Comments
 * and blanks are dropped: the output is a container env-file, not a human file.
 */
export function filterEnvContent(
  content: string,
  allowedKeys: Iterable<string>
): string {
  const allowed = new Set(allowedKeys);
  const lines = Object.entries(parseDotenv(content))
    .filter(([key]) => allowed.has(key))
    .map(([key, value]) => `${key}=${value}`);
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}