/**
 * Derives a branch-friendly slug from a run's prompt.
 *
 * Minimal form (slice #2): lowercase, runs of non-alphanumerics collapse to a
 * single hyphen, and leading/trailing hyphens are trimmed. An empty result
 * falls back to `run` so a branch name can always be formed.
 *
 * The fuller identity rules — dropping stop-words and truncating to a word
 * boundary under ~40 chars — land in a later slice.
 */
export function slugify(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'run';
}
