/** Longest branch-name slug we emit, in characters (a soft, word-boundary cap). */
const MAX_SLUG_LENGTH = 40;

/**
 * Common English stop-words dropped from slugs so a branch name carries the
 * meaningful words of a prompt. Kept deliberately small — only words that add
 * no recognition value to a branch name.
 */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'these',
  'this',
  'those',
  'to',
  'with',
]);

/**
 * Derives a branch-friendly slug from a run's prompt: lowercase, runs of
 * non-alphanumerics become word boundaries, stop-words are dropped, and the
 * remaining words are joined with hyphens up to a word boundary under
 * ~40 chars. An empty result (e.g. an all-stop-word or punctuation-only
 * prompt) falls back to `run` so a branch name can always be formed.
 */
export function slugify(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 0 && !STOP_WORDS.has(word));

  if (words.length === 0) return 'run';

  let slug = words[0];
  for (const word of words.slice(1)) {
    if (slug.length + 1 + word.length > MAX_SLUG_LENGTH) break;
    slug += `-${word}`;
  }
  return slug;
}
