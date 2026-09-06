import { format, styleText } from 'node:util';
import type { WriteStream } from 'node:tty';

/**
 * Semantic, color-coded line logging for the `e` CLI.
 *
 * Call sites name a *category* — what the line means, not what color it is —
 * and this module owns the mapping from category to color and stream. There is
 * one place to change what "error" or "command" looks like.
 *
 * Colors come from Node's built-in `util.styleText` (no dependency). It strips
 * color automatically when the target stream is not a TTY or `NO_COLOR` is set,
 * so redirected/piped output stays plain with no handling here — the `{ stream }`
 * option points that TTY check at the same stream the line is written to.
 *
 * Every method takes `console`-style rest args: the whole formatted line is
 * colored one color (a red error line, a blue command line), so a single call
 * can't mix a colored label with an uncolored body — use separate calls for that.
 *
 * | category | color  | stream |
 * |----------|--------|--------|
 * | error    | red    | stderr |
 * | warn     | yellow | stderr |
 * | success  | green  | stdout |
 * | info     | plain  | stdout |
 * | command  | blue   | stdout |
 */

type Color = 'red' | 'yellow' | 'green' | 'blue';

function write(
  stream: WriteStream,
  color: Color | undefined,
  args: unknown[]
): void {
  const text = format(...args);
  stream.write((color ? styleText(color, text, { stream }) : text) + '\n');
}

export const log = {
  /** A failure. Red, on stderr. */
  error: (...args: unknown[]): void => write(process.stderr, 'red', args),
  /** A caution that isn't fatal. Yellow, on stderr. */
  warn: (...args: unknown[]): void => write(process.stderr, 'yellow', args),
  /** A completed action. Green, on stdout. */
  success: (...args: unknown[]): void => write(process.stdout, 'green', args),
  /** Neutral status. Uncolored, on stdout. */
  info: (...args: unknown[]): void => write(process.stdout, undefined, args),
  /** An executed command or engine action (`> docker …`, git ops). Blue, on stdout. */
  command: (...args: unknown[]): void => write(process.stdout, 'blue', args),
};
