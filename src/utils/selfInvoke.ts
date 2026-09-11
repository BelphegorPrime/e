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

export function selfInvocation(
  argv: string[] = process.argv,
  sea: boolean = isSea()
): SelfInvocation {
  return sea
    ? { command: argv[0], prefix: [] }
    : { command: argv[0], prefix: [argv[1]] };
}
