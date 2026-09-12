/**
 * The message of anything thrown. Code that catches `unknown` needs the text
 * for a log line, a status record or an HTTP body; a `(err as Error).message`
 * cast reads `undefined` off a thrown string or object, so the check lives
 * here once. Node built-ins only: bundled into the container scripts.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
