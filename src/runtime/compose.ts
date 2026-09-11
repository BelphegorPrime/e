import { spawnSync } from 'child_process';
import { log } from '../utils/log.js';

export function composeUpArgs(composeFile: string, envFile?: string): string[] {
  const args = ['compose'];
  if (envFile) {
    args.push('--env-file', envFile);
  }
  return [...args, '-f', composeFile, 'up', '-d', '--build'];
}

export function composeWaitArgs(
  composeFile: string,
  envFile?: string
): string[] {
  const args = ['compose'];
  if (envFile) {
    args.push('--env-file', envFile);
  }
  return [...args, '-f', composeFile, 'wait', 'bootstrap'];
}

export function composeRestartArgs(
  composeFile: string,
  envFile?: string,
  service = 'llama'
): string[] {
  const args = ['compose'];
  if (envFile) {
    args.push('--env-file', envFile);
  }
  return [...args, '-f', composeFile, 'restart', service];
}

export function runComposeStack(
  runtimeCommand: string,
  composeFile: string,
  envFile?: string,
  waitForBootstrap = true
): void {
  if (!waitForBootstrap) {
    const args = composeUpArgs(composeFile, envFile);

    log.command(`> ${runtimeCommand} ${args.join(' ')}`);

    const result = spawnSync(runtimeCommand, args, {
      stdio: 'inherit',
      shell: false,
    });

    if (result.error) {
      throw new Error(
        `Failed to start ${runtimeCommand} compose: ${result.error.message}`
      );
    }

    if (result.status !== 0) {
      throw new Error(
        `Compose startup failed (exit code ${result.status ?? 1}).`
      );
    }

    return;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const args = composeUpArgs(composeFile, envFile);

    log.command(`> ${runtimeCommand} ${args.join(' ')}`);

    const result = spawnSync(runtimeCommand, args, {
      stdio: 'inherit',
      shell: false,
    });

    if (result.error) {
      throw new Error(
        `Failed to start ${runtimeCommand} compose: ${result.error.message}`
      );
    }

    if (result.status !== 0) {
      throw new Error(
        `Compose startup failed (exit code ${result.status ?? 1}).`
      );
    }

    const waitArgs = composeWaitArgs(composeFile, envFile);

    log.command(`> ${runtimeCommand} ${waitArgs.join(' ')}`);

    const waitResult = spawnSync(runtimeCommand, waitArgs, {
      stdio: 'inherit',
      shell: false,
    });

    if (waitResult.error) {
      throw new Error(
        `Failed to wait for ${runtimeCommand} compose: ${waitResult.error.message}`
      );
    }

    if (waitResult.status === 0) {
      return;
    }

    const exitCode = waitResult.status ?? 1;
    if (attempt === 2 || exitCode !== 22) {
      throw new Error(`Compose bootstrap failed (exit code ${exitCode}).`);
    }

    const restartArgs = composeRestartArgs(composeFile, envFile);
    log.command(`> ${runtimeCommand} ${restartArgs.join(' ')}`);
    const restartResult = spawnSync(runtimeCommand, restartArgs, {
      stdio: 'inherit',
      shell: false,
    });

    if (restartResult.error || restartResult.status !== 0) {
      throw new Error(`Compose bootstrap failed (exit code ${exitCode}).`);
    }
  }
}
