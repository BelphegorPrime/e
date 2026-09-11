import * as cp from 'node:child_process';
import type { Buffer } from 'node:buffer';
import type { Command } from 'commander';
import { LOCAL_RUNTIMES, type LocalRuntime } from '../init/localRuntimes.js';
import { log } from '../utils/log.js';
import { env } from '../utils/env.js';

/**
 * The minimal spawn surface these commands use. Abstracted from
 * `typeof cp.spawnSync` (whose overloads make fakes painful) so the download
 * flow stays trivially injectable in tests.
 */
export interface SpawnSyncLike {
  (
    command: string,
    args: readonly string[],
    options?: { stdio?: unknown; shell?: boolean }
  ): {
    status: number | null;
    error?: Error;
    signal: string | null;
    stdout: string | Buffer;
    stderr: string | Buffer;
  };
}

/**
 * Registers one top-level command per local runtime (`e llamacpp download
 * <model>`, `e ollama download <model>`, ...). Model downloads are the manual
 * counterpart to `e init`'s runtime selection: bootstrap.sh registers the
 * runtime as an OmniRoute provider and deliberately never downloads anything,
 * so a multi-GB model fetch stays an explicit, on-demand action against a
 * running stack.
 */
export function registerRuntimeCommands(program: Command): void {
  for (const runtime of LOCAL_RUNTIMES) {
    program
      .command(runtime.id)
      .description(`Manage the ${runtime.label} local runtime`)
      .command('download <model>')
      .description(`Download <model> into the running ${runtime.label} stack`)
      .action((model: string) => {
        downloadModel(runtime.id, model);
      });
  }
}

/**
 * Handles `e <runtime> download <model>` for a running compose stack. Each
 * runtime has its own download surface: llama.cpp registers the model through
 * its HTTP API (the same POST the old bootstrap used), Ollama pulls through
 * its CLI inside the container, and vLLM pulls weights on first load - there
 * is no pull command to invoke, so this reports the handoff. `spawn` is
 * injectable for tests and defaults to the real `spawnSync`.
 */
export function downloadModel(
  runtime: LocalRuntime,
  model: string,
  spawn: SpawnSyncLike = cp.spawnSync
): void {
  switch (runtime) {
    case 'llamacpp':
      downloadLlamacpp(model, spawn);
      return;
    case 'ollama':
      downloadOllama(model, spawn);
      return;
    case 'vllm':
      log.info(
        `vLLM downloads "${model}" on first request; serve it through http://127.0.0.1:8000/v1.`
      );
      return;
  }
}

function downloadLlamacpp(model: string, spawn: SpawnSyncLike): void {
  log.info(
    `Registering "${model}" with llama.cpp at ${env.localLlamaUrl} (starts its download)...`
  );
  const result = spawn(
    'curl',
    [
      '-sf',
      '-X',
      'POST',
      `${env.localLlamaUrl}/models`,
      '-H',
      'Content-Type: application/json',
      '-d',
      JSON.stringify({ model }),
    ],
    { stdio: 'inherit', shell: false }
  );
  if (result.error) {
    throw new Error(`Failed to start curl: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `llama.cpp rejected the model download (exit code ${result.status ?? 1}). Is the stack running? Try \`docker compose -f .e/compose.yaml up -d\`.`
    );
  }
  log.success(`Model "${model}" is downloading into llama.cpp.`);
}

function downloadOllama(model: string, spawn: SpawnSyncLike): void {
  log.info(`Pulling "${model}" into the ollama container...`);
  const result = spawn('docker', ['exec', 'ollama', 'ollama', 'pull', model], {
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    throw new Error(`Failed to start docker: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `ollama pull failed (exit code ${result.status ?? 1}). Is the stack running? Try \`docker compose -f .e/compose.yaml up -d\`.`
    );
  }
  log.success(`Model "${model}" pulled into Ollama.`);
}
