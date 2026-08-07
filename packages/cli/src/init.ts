import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { renderDockerfile } from './harness/renderDockerfile';
import {
  HARNESSES,
  dockerfilePath,
  harnessDir,
  harnessesBaseDir,
} from './harness/index';

interface InitCommandOptions {
  dir?: string;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description(
      'Write the harness Dockerfiles so `spawn` can build their images',
    )
    .option(
      '--dir <path>',
      'root directory to write the harnesses into (default: home directory)',
    )
    .action((opts: InitCommandOptions) => {
      const root = opts.dir ? path.resolve(opts.dir) : undefined;

      for (const harness of Object.values(HARNESSES)) {
        const dir = harnessDir(harness, root);
        const file = dockerfilePath(harness, root);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, renderDockerfile(harness.dockerfile));
        console.log(`wrote ${file}`);
      }

      console.log(
        `\nInitialized ${Object.keys(HARNESSES).length} harnesses in ${harnessesBaseDir(root)}.`,
      );
      console.log('Run `e spawn <harness> <prompt>` to build and run one.');
    });
}
