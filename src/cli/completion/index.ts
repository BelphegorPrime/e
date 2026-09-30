import { Command } from 'commander';
import tab from '@bomb.sh/tab/commander';
import type { RootCommand } from '@bomb.sh/tab';
import { RUNTIMES } from '../../ports/runtime/registry.js';
import { listFusionProfileNames } from '../../core/fusion/load.js';
import { findRoot } from '../../core/store/root.js';

/**
 * Register shell completions for the program.
 * Adds a `completion` command to generate shell scripts.
 * Also handles completion requests from the shell. Returns the completion
 * tree, for its tests.
 */
export function registerCompletion(program: Command): RootCommand {
  const completion = tab(program, {
    completionCommandName: 'completion',
  });

  // Dynamic runtime completion for every command that starts runs
  for (const name of ['spawn', 'resume', 'fuse']) {
    const runtimeOption = completion.commands.get(name)?.options.get('runtime');
    if (runtimeOption) {
      runtimeOption.handler = complete => {
        for (const runtime of RUNTIMES) complete(runtime.name, runtime.label);
      };
    }
  }

  // The Store's fusion profiles for 'fuse'
  const profileArgument = completion.commands
    .get('fuse')
    ?.arguments.get('profile');
  if (profileArgument) {
    profileArgument.handler = complete => {
      for (const name of listFusionProfileNames(findRoot())) complete(name, '');
    };
  }

  // Dynamic port completion for 'serve'
  const serveCommand = completion.commands.get('serve');
  const portOption = serveCommand?.options.get('port');
  if (portOption) {
    portOption.handler = complete => {
      complete('3000', 'Default UI port');
      complete('8080', 'Alternative port');
    };
  }
  return completion;
}
