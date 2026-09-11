import fs from 'fs';
import path from 'path';
import os from 'os';

const MARKER_BEGIN = '# >>> e shell completion >>>';
const MARKER_END = '# <<< e shell completion <<<';

/** Where each shell's startup file lives, relative to the home directory. */
const RC_FILE_FOR_SHELL: Record<string, (home: string) => string> = {
  bash: home => path.join(home, '.bashrc'),
  zsh: home => path.join(home, '.zshrc'),
  fish: home => path.join(home, '.config', 'fish', 'config.fish'),
};

/** The line that loads `e`'s completions for a given shell. */
export function completionSourceCommand(shell: string): string {
  switch (shell) {
    case 'zsh':
      return 'source <(e completion zsh)';
    case 'fish':
      return 'source <(e completion fish)';
    case 'powershell':
      return 'e completion powershell | Out-String | Invoke-Expression';
    default:
      return 'source <(e completion bash)';
  }
}

export type ShellRcResult =
  | { status: 'added'; file: string }
  | { status: 'already-configured'; file: string }
  | { status: 'unsupported' };

/**
 * Appends a guarded completion-loading block to the shell's rc file, unless
 * one is already there. `powershell` (and any other unmapped shell) is
 * reported as unsupported - its startup file ($PROFILE) isn't a fixed path,
 * so the caller falls back to printing the command for the user to add by
 * hand.
 */
export function ensureShellRcEntry(
  shell: string,
  homeDir: string = os.homedir()
): ShellRcResult {
  const rcFileFor = RC_FILE_FOR_SHELL[shell];
  if (!rcFileFor) {
    return { status: 'unsupported' };
  }

  const file = rcFileFor(homeDir);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  if (existing.includes(MARKER_BEGIN)) {
    return { status: 'already-configured', file };
  }

  const block = `\n${MARKER_BEGIN}\n${completionSourceCommand(shell)}\n${MARKER_END}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, block);

  return { status: 'added', file };
}
