/**
 * **The `e spawn` command line, as a type.**
 *
 * Four places re-invoke this CLI as a child - a Sibling run, an A2A task, the
 * browser terminal, and `serve --detached` - and two of them used to spell the
 * argv out as string literals. Nothing connected those literals to the flags
 * `registerSpawnCommand` actually declares, so renaming a flag compiled
 * cleanly and broke at run time, in a child process, with the error landing in
 * a log nobody reads.
 *
 * The flag names live here and the command declares itself from them, so the
 * two cannot drift: rename a constant and every caller that no longer fits
 * fails to compile.
 *
 * It sits in `shared` because both `engine` (siblings, A2A tasks) and `cli`
 * (the terminal, detached serve) build one, and the layer rule runs
 * `shared -> ... -> engine -> cli`.
 */

/** The flags `e spawn` accepts, by the name a caller passes on the command line. */
export const SPAWN_FLAGS = {
  name: '--name',
  skill: '--skill',
  mcp: '--mcp',
  envFile: '--env-file',
  dir: '--dir',
  runtime: '--runtime',
  rebuild: '--rebuild',
  keepWorktree: '--keep-worktree',
} as const;

/** The subcommand itself, so a caller never writes `'spawn'` either. */
export const SPAWN_COMMAND = 'spawn';

/**
 * Everything a child `e spawn` invocation can carry. Absent is absent: a run
 * without a prompt opens the harness TUI, which is what the browser terminal
 * wants and what a Sibling run must never do.
 */
export interface SpawnArgs {
  agent: string;
  /** A prompt runs one-shot; without one the harness TUI opens (`isInteractiveRun`). */
  prompt?: string;
  /** `--name`: the run slug, overriding the prompt-derived one. */
  name?: string;
  /** `--skill`, one flag per entry. */
  skills?: readonly string[];
  /** `--mcp`, one flag per entry. */
  mcp?: readonly string[];
  /**
   * Arguments inherited verbatim from the parent's own invocation (`--dir`,
   * `--env-file`). Already formatted, because the parent received them that
   * way and passes them on unread.
   */
  passthrough?: readonly string[];
}

/**
 * The arguments after the executable: `spawn <agent> [flags] [-- <prompt>]`.
 *
 * The prompt goes last and behind `--` so a prompt that begins with a dash is
 * text rather than a flag.
 */
export function spawnArgs(spec: SpawnArgs): string[] {
  const args: string[] = [SPAWN_COMMAND, spec.agent];
  if (spec.name !== undefined) args.push(SPAWN_FLAGS.name, spec.name);
  for (const skill of spec.skills ?? []) args.push(SPAWN_FLAGS.skill, skill);
  for (const server of spec.mcp ?? []) args.push(SPAWN_FLAGS.mcp, server);
  args.push(...(spec.passthrough ?? []));
  if (spec.prompt !== undefined) args.push('--', spec.prompt);
  return args;
}
