import type { Protocol } from '../harness/adapter';

/**
 * The curated per-protocol, per-tier model **preference list** behind `auto`
 * resolution (ADR-0007). For a given `(protocol, tier)`, the entries are tried in
 * order and the first one that is a *prefix of* an available model id wins — so a
 * preferred `claude-opus-5` matches a dated `claude-opus-5-20260101`.
 *
 * This is an opinionated, human-reviewed list (the HITL gate). The Anthropic ids
 * are current; the **OpenAI and Google ids are provisional** and expected to be
 * corrected as models ship. A user can always bypass it with a concrete `model`
 * or a Provider `defaultModel`.
 */
export const MODEL_PREFERENCES: Record<Protocol, Record<string, string[]>> = {
  'anthropic-messages': {
    smart: ['claude-opus-5', 'claude-sonnet-5'],
    fast: ['claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    cheap: ['claude-haiku-4-5-20251001', 'claude-sonnet-5'],
    review: ['claude-opus-5', 'claude-sonnet-5'],
  },
  'openai-responses': {
    smart: ['gpt-5-codex', 'gpt-5'],
    fast: ['gpt-5', 'gpt-5-codex'],
    cheap: ['gpt-5-mini', 'gpt-5-codex'],
    review: ['gpt-5-codex', 'gpt-5'],
  },
  'openai-chat': {
    smart: ['gpt-5', 'gpt-5-codex'],
    fast: ['gpt-5', 'gpt-5-mini'],
    cheap: ['gpt-5-mini'],
    review: ['gpt-5'],
  },
  google: {
    smart: ['gemini-2.5-pro'],
    fast: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    cheap: ['gemini-2.5-flash'],
    review: ['gemini-2.5-pro'],
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
  tier: string,
  defaultModel?: string,
): string {
  const preferred = MODEL_PREFERENCES[protocol]?.[tier] ?? [];
  for (const pref of preferred) {
    const match = available.find((id) => matchesPreferred(id, pref));
    if (match) return match;
  }
  if (defaultModel) return defaultModel;

  if (preferred.length === 0) {
    throw new Error(
      `No model preference list for tier "${tier}" under protocol "${protocol}". ` +
        `Use a curated tier (smart, fast, cheap, review), a concrete model, or set the provider's defaultModel.`,
    );
  }
  throw new Error(
    `No preferred model for tier "${tier}" (${protocol}) is available at the endpoint. ` +
      `Tried: ${preferred.join(', ')}. Available: ${available.join(', ') || '(none)'}. ` +
      `Set the provider's defaultModel or pick a concrete model.`,
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
