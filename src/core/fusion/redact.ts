/**
 * **Known secrets out of a fusion's record and material** (#180): the host
 * knows the values in the Store's `.env`, so any of them a candidate wrote
 * into its worktree - a key a tool printed into a file, a token in a
 * fixture - is replaced by `[redacted:<NAME>]` before the patch and files are
 * kept in the record, and so before the synthesizer, on another provider,
 * ever sees them.
 *
 * Only values that are secrets: those of keys whose name says so
 * ({@link SECRET_NAME}) and of the keys an Agent names as its `apiKeyEnv`,
 * at least `MIN_SECRET_LENGTH` long (`shared/utils/secrets`). A base URL or a model id in the
 * same file is configuration, and replacing it would mangle code that
 * merely mentions it. Unknown secrets - one the agent made up or fetched -
 * are beyond any host-side redaction; the threat model says so.
 */

import { secretsToRedact } from '../../shared/utils/secrets.js';

/**
 * A key name that holds a secret: one of these as a whole `_`-separated
 * segment (`OPENAI_API_KEY`, `GITHUB_TOKEN`, `JWT_SECRET`), so
 * `GIT_AUTHOR_NAME` or `KEYBOARD_LAYOUT` is not one.
 */
export const SECRET_NAME =
  /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIALS?|AUTH)(_|$)/i;

/** Replaces known secret values in text and bytes. */
export interface Redactor {
  text(value: string): string;
  /** The input itself when nothing was replaced. */
  bytes(value: Buffer): Buffer;
  /** True when there is nothing to replace. */
  readonly empty: boolean;
}

/**
 * The redactor for `env` (the Store's `.env`): every value of a
 * secret-looking key, and of every key in `names`.
 */
export function secretRedactor(
  env: Readonly<Record<string, string>>,
  names: Iterable<string> = []
): Redactor {
  const named = new Set(names);
  const nameOf = new Map<string, string>();
  for (const [name, value] of Object.entries(env)) {
    if ((named.has(name) || SECRET_NAME.test(name)) && !nameOf.has(value)) {
      nameOf.set(value, name);
    }
  }
  // Long enough to be a secret, the longest first (a secret that contains
  // another is replaced whole): the rule a kept session is masked by.
  const secrets = secretsToRedact(nameOf.keys()).map(value => ({
    value,
    bytes: Buffer.from(value),
    placeholder: `[redacted:${nameOf.get(value)}]`,
  }));
  return {
    empty: secrets.length === 0,
    text(input) {
      let out = input;
      for (const s of secrets) out = out.split(s.value).join(s.placeholder);
      return out;
    },
    bytes(input) {
      let out = input;
      for (const s of secrets) {
        if (out.indexOf(s.bytes) < 0) continue;
        const parts: Buffer[] = [];
        let from = 0;
        for (
          let at = out.indexOf(s.bytes);
          at >= 0;
          at = out.indexOf(s.bytes, from)
        ) {
          parts.push(out.subarray(from, at), Buffer.from(s.placeholder));
          from = at + s.bytes.length;
        }
        parts.push(out.subarray(from));
        out = Buffer.concat(parts);
      }
      return out;
    },
  };
}
