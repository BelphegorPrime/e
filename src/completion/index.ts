import { Command } from 'commander';
import tab from '@bomb.sh/tab/commander';

/**
 * Register shell completions for the program.
 * Adds a `completion` command to generate shell scripts.
 * Also handles completion requests from the shell.
 */
export function registerCompletion(program: Command): void {
  const completion = tab(program, {
    completionCommandName: 'completion',
  });

  // Dynamic runtime completion for 'spawn'
  const spawnCommand = completion.commands.get('spawn');
  const runtimeOption = spawnCommand?.options.get('runtime');
  if (runtimeOption) {
    runtimeOption.handler = (complete) => {
      complete('docker', 'Use Docker runtime');
      complete('podman', 'Use Podman runtime');
    };
  }

  // Dynamic port completion for 'serve'
  const serveCommand = completion.commands.get('serve');
  const portOption = serveCommand?.options.get('port');
  if (portOption) {
    portOption.handler = (complete) => {
      complete('3000', 'Default UI port');
      complete('8080', 'Alternative port');
    };
  }
}
