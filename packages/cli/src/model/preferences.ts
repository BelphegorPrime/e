import type { Protocol } from '../harness/adapter';

export const TIERS = ['default', 'smart', 'fast', 'cheap', 'review'] as const;
export type Tier = (typeof TIERS)[number];

/**
 * The curated per-protocol, per-tier model **preference list** behind `auto`
 * resolution (ADR-0007). For a given `(protocol, tier)`, the entries are tried in
 * order and the first one that matches an available model id wins — exact, or the
 * preferred id followed by a version/date suffix (`anthropic.claude-haiku-4-5`
 * matches `anthropic.claude-haiku-4-5-20251001-v1:0`), never a named sibling.
 *
 * This is an opinionated, human-reviewed list (the HITL gate), tuned to the
 * maintainer's gateway — whose ids are namespaced by provider (`anthropic.`,
 * `openai.`). A different gateway may name models differently; a user overrides
 * with a concrete `model` or a Provider `defaultModel`. `google` is intentionally
 * absent (that gateway offers only Gemma, no Gemini) — a `google` + `auto`
 * provider gets a clear "no preference list" error. It is a {@link Partial}
 * record for exactly that reason.
 */
export const MODEL_PREFERENCES: Partial<
  Record<Protocol, Record<Tier, string[]>>
> = {
  'anthropic-messages': {
    default: [],
    smart: ['anthropic.claude-opus-5', 'anthropic.claude-sonnet-5'],
    fast: ['anthropic.claude-sonnet-5', 'anthropic.claude-haiku-4-5'],
    cheap: ['anthropic.claude-haiku-4-5', 'anthropic.claude-sonnet-5'],
    review: ['anthropic.claude-opus-5', 'anthropic.claude-sonnet-5'],
  },
  // gpt-5.6 variants map to a capability ladder: luna < terra < sol
  // (haiku/sonnet/opus equivalents). Same ranking for both OpenAI wire APIs.
  'openai-responses': {
    default: [],
    smart: ['openai.gpt-5.6-sol', 'openai.gpt-5.5'],
    fast: ['openai.gpt-5.6-terra', 'openai.gpt-5.5'],
    cheap: ['openai.gpt-5.6-luna', 'openai.gpt-oss-20b'],
    review: ['openai.gpt-5.6-sol', 'openai.gpt-5.6-terra'],
  },
  'openai-chat': {
    default: [],
    smart: ['openai.gpt-5.6-sol', 'openai.gpt-5.5'],
    fast: ['openai.gpt-5.6-terra', 'openai.gpt-5.5'],
    cheap: ['openai.gpt-5.6-luna', 'openai.gpt-oss-20b'],
    review: ['openai.gpt-5.6-sol', 'openai.gpt-5.6-terra'],
  },
};

/**
 * Picks a concrete model id for a `(protocol, tier)` from {@link
 * MODEL_PREFERENCES}, purely: the first preferred id that matches one of
 * `available` (the ids the provider advertises) is chosen and the *available* id
 * is returned verbatim. A match is an exact id or the preferred id followed by a
 * version/date suffix (`claude-opus-5` matches `claude-opus-5-20260101`) — but
 * **not** a different family that merely shares a prefix (`gpt-5` must not match
 * `gpt-5-mini`), or the smart tier could silently resolve to a cheap model. If
 * nothing matches, `defaultModel` is used when given; otherwise this throws a
 * clear error naming what was tried — a silent wrong model is worse than a loud
 * failure.
 */
export function chooseModel(
  available: string[],
  protocol: Protocol,
  tier: Tier,
  defaultModel?: string
): string {
  const preferred = MODEL_PREFERENCES[protocol]?.[tier] ?? [];
  for (const pref of preferred) {
    const match = available.find(id => matchesPreferred(id, pref));
    if (match) return match;
  }
  if (defaultModel) return defaultModel;

  if (preferred.length === 0) {
    throw new Error(
      `No model preference list for tier "${tier}" under protocol "${protocol}". ` +
        `Use a curated tier (smart, fast, cheap, review), a concrete model, or set the provider's defaultModel.`
    );
  }
  throw new Error(
    `No preferred model for tier "${tier}" (${protocol}) is available at the endpoint. ` +
      `Tried: ${preferred.join(', ')}. Available: ${available.join(', ') || '(none)'}. ` +
      `Set the provider's defaultModel or pick a concrete model.`
  );
}

/**
 * Whether an available model id satisfies a preferred id: an exact match, or the
 * preferred id followed by a version/date suffix (`-` then a digit, e.g.
 * `claude-opus-5` → `claude-opus-5-20260101`). A named sibling that shares the
 * prefix (`gpt-5` → `gpt-5-mini`) is deliberately *not* a match.
 */
function matchesPreferred(id: string, pref: string): boolean {
  if (id === pref) return true;
  const rest = id.startsWith(pref) ? id.slice(pref.length) : '';
  return /^-\d/.test(rest);
}
