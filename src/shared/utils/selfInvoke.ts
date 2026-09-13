import { isSea } from 'node:sea';

/**
 * How to run this very CLI again as a child process: `spawn(command,
 * [...prefix, ...args])` is `e <args>`. The shape depends on how `e` runs:
 *
 * - Plain Node (`node dist/index.js`): the executable is `node`, and the
 *   entry script (`argv[1]`) has to be passed again.
 * - A pkg single-executable (`pkg --sea`): the executable runs the embedded
 *   entry by itself, and `argv[1]` is the snapshot path of that entry
 *   (`/snapshot/e/dist/index.js`) - passing it would hand the CLI an
 *   argument it takes for an unknown command.
 *
 * Both `serve --detached` and the browser terminal (ADR-0014) re-invoke `e`
 * this way, so the rule lives in one place.
 */
export interface SelfInvocation {
  command: string;
  prefix: string[];
}

/**
 * `selfInvocation()` checked to really be the e CLI: with a script entry it
 * must be the CLI's `index.js` (a single executable has none). Re-invoking any
 * other entry - a test file, say - would run *that* as every child, which
 * would spawn children of its own: a fork bomb. Better refused than tried.
 *
 * Every re-invocation goes through this, not just the ones that spawn runs:
 * `serve --detached` and the browser terminal re-invoke the CLI too, and a
 * wrong entry is no safer there.
 */
export function assertCliEntry(invocation: SelfInvocation): SelfInvocation {
  const [entry] = invocation.prefix;
  if (entry !== undefined && !/(^|[\\/])index\.(m?js|cjs)$/.test(entry)) {
    throw new Error(
      `Refusing to re-invoke "${entry}" as the e CLI: not its index.js entry`
    );
  }
  return invocation;
}

/** How to run this CLI again, with the entry checked. The form every caller should use. */
export function checkedSelfInvocation(
  argv?: string[],
  sea?: boolean
): SelfInvocation {
  return assertCliEntry(selfInvocation(argv, sea));
}

export function selfInvocation(
  argv: string[] = process.argv,
  sea: boolean = isSea()
): SelfInvocation {
  return sea
    ? { command: argv[0], prefix: [] }
    : { command: argv[0], prefix: [argv[1]] };
}
