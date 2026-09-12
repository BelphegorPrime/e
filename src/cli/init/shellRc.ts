import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';

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

/** The minimal `spawnSync` surface {@link powerShellProfilePath} needs; tests inject a fake. */
export interface ProfileSpawn {
  (
    command: string,
    args: readonly string[],
    options: { encoding: 'utf8'; shell: false; windowsHide: true }
  ): { status: number | null; error?: Error; stdout: string | Buffer };
}

/**
 * PowerShell's per-user startup file. Unlike the POSIX shells it is not a
 * fixed path (`$PROFILE` depends on the PowerShell edition and a possibly
 * redirected Documents folder), so PowerShell itself is asked - `pwsh`
 * (PowerShell 7) first, then Windows PowerShell 5.1. Undefined when neither is
 * installed or answers with an absolute path.
 */
export function powerShellProfilePath(
  spawn: ProfileSpawn = spawnSync as unknown as ProfileSpawn
): string | undefined {
  for (const executable of ['pwsh', 'powershell']) {
    const result = spawn(
      executable,
      ['-NoProfile', '-NonInteractive', '-Command', '$PROFILE'],
      { encoding: 'utf8', shell: false, windowsHide: true }
    );
    if (result.error || result.status !== 0) continue;
    const profile = String(result.stdout ?? '').trim();
    if (profile && path.isAbsolute(profile)) return profile;
  }
  return undefined;
}

/**
 * Appends a guarded completion-loading block to the shell's rc file, unless
 * one is already there. The POSIX shells map to a fixed file under `homeDir`;
 * `powershell` writes to the profile `resolveProfile` reports (PowerShell's
 * own `$PROFILE`). An unmapped shell, or a PowerShell that cannot be located,
 * is reported as unsupported so the caller prints the command for the user to
 * add by hand.
 */
export function ensureShellRcEntry(
  shell: string,
  homeDir: string = os.homedir(),
  resolveProfile: () => string | undefined = powerShellProfilePath
): ShellRcResult {
  const file =
    shell === 'powershell'
      ? resolveProfile()
      : RC_FILE_FOR_SHELL[shell]?.(homeDir);
  if (!file) {
    return { status: 'unsupported' };
  }

  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  if (existing.includes(MARKER_BEGIN)) {
    return { status: 'already-configured', file };
  }

  const block = `\n${MARKER_BEGIN}\n${completionSourceCommand(shell)}\n${MARKER_END}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, block);

  return { status: 'added', file };
}
