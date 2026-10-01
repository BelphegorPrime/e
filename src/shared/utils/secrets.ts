/**
 * **Which values count as secrets to mask**, shared by every place the host
 * scrubs what it knows out of what it keeps: a kept session (#205,
 * ADR-0017) and a fusion's record and synthesis material (#180).
 */

/**
 * The shortest value treated as a secret. Shorter ones (`1`, `true`, a port)
 * would mask ordinary text everywhere; no API key is that short.
 */
export const MIN_SECRET_LENGTH = 8;

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
