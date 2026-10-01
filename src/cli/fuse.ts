import type { Command } from 'commander';
import type { ContainerRunner } from '../ports/runtime/index.js';
import { resolveRuntime, RUNTIME_NAMES } from '../ports/runtime/registry.js';
import { HostGit } from '../ports/git/host.js';
import type { Git } from '../ports/git/index.js';
import {
  findFusionProfile,
  type FoundFusionProfile,
} from '../core/fusion/load.js';
import type { FusionProfile } from '../core/fusion/profile.js';
import type { CandidateResult } from '../core/fusion/result.js';
import { findRoot } from '../core/store/root.js';
import { readConfig } from '../core/store/config.js';
import { eBaseDir } from '../core/store/paths.js';
import { defaultWorktreesDir } from '../engine/runs/worktreesDir.js';
import {
  spawnChildProcess,
  type ChildHandle,
  type ChildLauncher,
} from '../engine/runs/childRun.js';
import {
  CANCELED_EXIT_CODE,
  EXHAUSTED_EXIT_CODE,
} from '../engine/runs/runSpawn.js';
import {
  FUSION_KILL_GRACE_MS,
  runFanOut,
  type FanOutDeps,
  type FanOutEvent,
  type FanOutParams,
  type FanOutResult,
} from '../engine/fusion/fanOut.js';
import {
  runSynthesis,
  type SynthesisDeps,
  type SynthesisEvent,
  type SynthesisParams,
  type SynthesisResult,
} from '../engine/fusion/synthesis.js';
import {
  fusionRecordDirFor,
  type FusionState,
} from '../engine/fusion/record.js';
import {
  fileHostSlots,
  hostSlotsDir,
  type HostSlots,
} from '../engine/fusion/hostSlots.js';
import { SPAWN_FLAGS } from '../shared/spawnArgs.js';
import { env } from '../shared/utils/env.js';
import { log } from '../shared/utils/log.js';
import { errorMessage } from '../shared/utils/errors.js';
import type { ReportLine } from './spawn.js';

/**
 * **`e fuse <profile> "<prompt>"`** (ADR-0019 sections 3, 8 and 9): one task
 * to every candidate Agent of a Fusion profile, then one synthesis run over
 * what they produced. The profile is resolved and validated first, so a
 * broken one fails before any image, worktree or container exists; then the
 * fan-out, then - only when it closed with enough usable candidates - the
 * synthesis.
 *
 * What the user sees is a pure function of the stages' events
 * ({@link fuseEventLines}) and of how they ended ({@link fuseReport},
 * {@link fuseExitCode}): plain lines, one per state change, each tagged with
 * its stage, so a CI log reads the same as a terminal.
 */

/** The parsed `e fuse` options: the subset of `e spawn`'s every candidate inherits. */
export interface FuseCommandOptions {
  runtime?: string;
  dir?: string;
  envFile?: string;
  keepWorktree?: boolean;
}

/** Every event a fusion reports, from either stage. */
export type FuseEvent = FanOutEvent | SynthesisEvent;

/** How a fusion ended: its fan-out, and its synthesis when one ran. */
export interface FuseOutcome {
  fanOut: FanOutResult;
  synthesis?: SynthesisResult;
}

/** The stage tags that keep the two phases apart in the output. */
const CANDIDATES_STAGE = '[candidates]';
const SYNTHESIS_STAGE = '[synthesis]';

/**
 * The `e spawn` arguments every candidate and the synthesis inherit: the
 * Store (`--dir`), the env file and the one runtime this fusion resolved, so
 * no child picks a different engine than its siblings.
 */
export function fusePassthroughArgs(
  opts: Pick<FuseCommandOptions, 'dir' | 'envFile'>,
  runtime: string
): string[] {
  return [
    ...(opts.dir ? [SPAWN_FLAGS.dir, opts.dir] : []),
    ...(opts.envFile ? [SPAWN_FLAGS.envFile, opts.envFile] : []),
    SPAWN_FLAGS.runtime,
    runtime,
  ];
}

/**
 * The task from the command line, or a throw: a fusion is always
 * non-interactive, since nobody is at N harness TUIs at once.
 */
export function fusePrompt(profile: string, words: readonly string[]): string {
  const prompt = words.join(' ').trim();
  if (prompt === '') {
    throw new Error(
      `e fuse needs a prompt: a fusion runs every candidate non-interactively. Try: e fuse ${profile} "<task>"`
    );
  }
  return prompt;
}

/** The lines one event prints; `profile` names the synthesizer the synthesis events leave out. */
export function fuseEventLines(
  event: FuseEvent,
  profile: Pick<
    FusionProfile,
    'name' | 'synthesizer' | 'maxConcurrency' | 'minUsable'
  >
): ReportLine[] {
  switch (event.kind) {
    case 'prepared':
      return [
        {
          level: 'info',
          text: `Fusion ${event.fusion} (profile ${profile.name})`,
        },
        {
          level: 'info',
          text: `Pinned base: ${event.base.branch} @ ${event.base.sha}`,
        },
        {
          level: 'info',
          text: `Candidates: ${event.candidates.map(c => c.agent).join(', ')} (at most ${profile.maxConcurrency} at a time; the synthesis needs ${profile.minUsable} usable)`,
        },
        { level: 'info', text: `Synthesizer: ${profile.synthesizer}` },
        ...event.candidates.map((c): ReportLine => ({
          level: 'info',
          text: `${CANDIDATES_STAGE} ${c.candidate} ${c.agent}: queued`,
        })),
      ];
    case 'launched':
      return [
        {
          level: 'info',
          text: `${CANDIDATES_STAGE} ${event.candidate} ${event.agent}: running${event.retryOf ? ` (attempt ${event.attempt}, retry of ${event.retryOf})` : ''}`,
        },
      ];
    case 'retry-scheduled':
      return [
        {
          level: 'info',
          text: `${CANDIDATES_STAGE} ${event.candidate} ${event.agent}: queued (attempt ${event.attempt}, retry of ${event.retryOf}, not before ${event.notBefore})`,
        },
      ];
    case 'retry-skipped':
      return [
        {
          level: 'info',
          text: `${CANDIDATES_STAGE} ${event.candidate} ${event.agent}: no retry (${event.why === 'max-attempts' ? `attempt ${event.attempt} was the last allowed` : "it could not start before the fusion's deadline"})`,
        },
      ];
    case 'budget-exhausted':
      return [
        {
          level: 'warn',
          text: `${event.budget === 'candidatesMs' ? CANDIDATES_STAGE : '[fusion]'} ${event.budget} (${event.limitMs} ms) exhausted${event.stopped.length > 0 ? `: stopped ${event.stopped.join(', ')}` : ''}`,
        },
      ];
    case 'host-slot-wait':
      return [
        {
          level: 'info',
          text: `${CANDIDATES_STAGE} ${event.candidate} ${event.agent}: waiting for a host slot (fusion.hostConcurrency ${event.limit}, shared with every e fuse on this host)`,
        },
      ];
    case 'settled':
      return [candidateLine(event.result)];
    case 'closed':
      return [
        {
          level: 'info',
          text: `${CANDIDATES_STAGE} closed: ${event.usable} usable; ${event.pushed.length > 0 ? `pushed ${event.pushed.join(', ')}` : 'nothing pushed'}`,
        },
        ...event.pushWarnings.map((warning): ReportLine => ({
          level: 'warn',
          text: `Warning: ${warning}`,
        })),
      ];
    case 'synthesis-launched':
      return [
        {
          level: 'info',
          text: `${SYNTHESIS_STAGE} ${event.id} ${event.agent}: running`,
        },
      ];
    case 'synthesis-settled':
      return [
        {
          level: event.exitCode === 0 ? 'success' : 'info',
          text: `${SYNTHESIS_STAGE} ${event.id} ${profile.synthesizer}: ${verdictLabel(event.exitCode)}`,
        },
      ];
  }
}

/** A settled candidate: its outcome, then what a reader weighs it by. */
function candidateLine(result: CandidateResult): ReportLine {
  const details: string[] = [];
  if (result.tip !== null && result.branch !== null) {
    details.push(result.branch);
    const files = result.changes.files.length;
    details.push(
      `${files} ${files === 1 ? 'file' : 'files'} +${result.changes.added} -${result.changes.removed}`
    );
  }
  if (result.verify) details.push(`verify ${result.verify.verdict}`);
  if (result.outcome === 'failed' && result.exitCode !== null) {
    details.push(`exit ${result.exitCode}`);
  }
  if (result.reason !== null) details.push(result.reason);
  if (result.retryOf !== null) {
    details.push(`attempt ${result.attempt}, retry of ${result.retryOf}`);
  }
  return {
    level: result.outcome === 'succeeded' ? 'success' : 'info',
    text: `${CANDIDATES_STAGE} ${result.candidate} ${result.agent}: ${result.outcome}${details.length > 0 ? ` (${details.join(', ')})` : ''}`,
  };
}

/** A run's exit code as its Verdict names it (ADR-0016), 143 being a cancel. */
function verdictWord(exitCode: number): string {
  if (exitCode === 0) return 'succeeded';
  if (exitCode === CANCELED_EXIT_CODE) return 'canceled';
  if (exitCode === EXHAUSTED_EXIT_CODE) return 'exhausted';
  return 'aborted';
}

/** {@link verdictWord}, with the code where the word alone does not give it. */
function verdictLabel(exitCode: number): string {
  const word = verdictWord(exitCode);
  return exitCode === 0 || exitCode === CANCELED_EXIT_CODE
    ? word
    : `${word} (exit ${exitCode})`;
}

/**
 * The fusion's exit code (ADR-0019 section 8): the synthesis run's Verdict
 * when it ran, `143` on a cancel, `2` when the fusion's `totalMs` fired, and
 * `1` for every other way a fusion ends without a result.
 */
export function fuseExitCode(outcome: FuseOutcome): number {
  const state: FusionState = outcome.synthesis?.state ?? outcome.fanOut.state;
  switch (state) {
    case 'canceled':
      return CANCELED_EXIT_CODE;
    case 'exhausted':
      return EXHAUSTED_EXIT_CODE;
    case 'completed':
      return outcome.synthesis?.exitCode ?? 1;
    default:
      return 1;
  }
}

/**
 * The closing report of a fusion, in order: the candidates' tally, how the
 * synthesis ended and where its work went - the same `Pull request:` and
 * `Run branch:` lines a single run ends with - and where the record is.
 */
export function fuseReport(
  outcome: FuseOutcome,
  profile: Pick<FusionProfile, 'minUsable'>,
  storeDir: string
): ReportLine[] {
  const { fanOut, synthesis } = outcome;
  const lines: ReportLine[] = [];
  const tally = new Map<string, number>();
  for (const result of fanOut.candidates) {
    tally.set(result.outcome, (tally.get(result.outcome) ?? 0) + 1);
  }
  lines.push({
    level: 'info',
    text: `\nCandidates: ${[...tally].map(([name, count]) => `${count} ${name}`).join(', ') || 'none'} (${fanOut.usable.length} of ${fanOut.candidates.length} usable).`,
  });

  const state = synthesis?.state ?? fanOut.state;
  const why = (reason: string | undefined) => (reason ? ` (${reason})` : '');
  if (synthesis) {
    lines.push({
      level: synthesis.exitCode === 0 ? 'success' : 'warn',
      text: `Synthesis ${verdictWord(synthesis.exitCode)}${why(synthesis.reason)}.`,
    });
    if (synthesis.pushed) {
      lines.push({
        level: 'success',
        text: 'Pushed to origin. Open a PR or merge when you like.',
      });
    }
    if (synthesis.pullRequestUrl) {
      lines.push({
        level: 'success',
        text: `Pull request: ${synthesis.pullRequestUrl}`,
      });
    }
  } else if (state === 'canceled') {
    lines.push({
      level: 'warn',
      text: 'Fusion canceled before its synthesis; nothing was pushed.',
    });
  } else if (state === 'exhausted') {
    lines.push({
      level: 'warn',
      text: `Fusion exhausted${why(fanOut.reason ?? 'exhausted:fusion-timeout')}: no synthesis, no PR.`,
    });
  } else if (fanOut.reason === 'aborted:no-usable-candidate') {
    lines.push({
      level: 'error',
      text: `Fusion failed (${fanOut.reason}): ${fanOut.usable.length} usable, the profile needs ${profile.minUsable}. No synthesis ran.`,
    });
  } else {
    lines.push({
      level: 'error',
      text: `Fusion ${state}${why(fanOut.reason)}: no synthesis ran.`,
    });
  }
  lines.push({
    level: 'info',
    text: `Fusion record: ${fusionRecordDirFor(storeDir, fanOut.fusion)}`,
  });
  if (synthesis?.branch) {
    lines.push({ level: 'success', text: `\nRun branch: ${synthesis.branch}` });
  }
  return lines;
}

/** What a fusion needs from the process it runs in; tests script each stage. */
export interface FuseCommandDeps {
  /** A cancel (Ctrl-C, SIGTERM), forwarded to both stages. */
  abort?: AbortSignal;
  git?: Git;
  /** Resolves the one container runtime every child uses. */
  resolveRuntime?: (preferred?: string) => Pick<ContainerRunner, 'engine'>;
  findProfile?: (name: string, root?: string) => FoundFusionProfile;
  fanOut?: (deps: FanOutDeps, params: FanOutParams) => Promise<FanOutResult>;
  synthesis?: (
    deps: SynthesisDeps,
    params: SynthesisParams
  ) => Promise<SynthesisResult>;
  /** Starts one child; defaults to re-invoking this CLI in a process group of its own. */
  launch?: ChildLauncher;
  worktreesDir?: string;
  /** Where the lines go; the log by default. */
  print?: (line: ReportLine) => void;
}

/**
 * The production launcher of a fusion: the CLI re-invoked, detached, so a
 * Ctrl-C at the terminal reaches only this coordinator, which then cancels
 * every child through its handle and lets each tear down (ADR-0019 section 9).
 */
const detachedLauncher: ChildLauncher = launch =>
  spawnChildProcess(launch, undefined, { detached: true });

/**
 * How long `e fuse` waits after a cancel before it kills its children and
 * exits on its own: past the coordinator's own {@link FUSION_KILL_GRACE_MS},
 * so this is the last resort of a coordinator that hangs itself, never the
 * way a stubborn child is stopped.
 */
export const FUSE_CANCEL_GRACE_MS = FUSION_KILL_GRACE_MS + 30_000;

/** What {@link fuseCancelHandling} works on; the action gives it the process, tests fakes. */
export interface FuseCancelDeps {
  cancel: AbortController;
  /** The children alive right now. */
  live: () => Iterable<ChildHandle>;
  exit: (code: number) => void;
  setTimer: (fn: () => void, ms: number) => void;
  warn: (text: string) => void;
}

/**
 * The signal handler of `e fuse` (ADR-0019 section 9). The first SIGINT or
 * SIGTERM cancels: every child gets SIGTERM and tears down, nothing more is
 * pushed. Every later one is acknowledged and waited out, never taken as
 * leave to exit: the children run in process groups of their own, so a
 * coordinator that went away would leave them running - pushing, opening a
 * PR. Only when the grace is spent are the children killed outright, and
 * then the coordinator exits 143.
 */
export function fuseCancelHandling(deps: FuseCancelDeps): () => void {
  return () => {
    if (deps.cancel.signal.aborted) {
      deps.warn('Still canceling: waiting for the runs to tear down.');
      return;
    }
    deps.warn('Canceling the fusion...');
    deps.cancel.abort();
    deps.setTimer(() => {
      for (const child of deps.live()) child.kill('SIGKILL');
      deps.exit(CANCELED_EXIT_CODE);
    }, FUSE_CANCEL_GRACE_MS);
  };
}

/**
 * The whole `e fuse`: refusals first (a nested fusion, a missing prompt, an
 * invalid profile, no repository, no runtime), then the fan-out, then the
 * synthesis when the fan-out closed with enough usable candidates. Returns
 * the exit code.
 */
export async function runFuseCommand(
  profileName: string,
  words: string[],
  opts: FuseCommandOptions,
  deps: FuseCommandDeps = {}
): Promise<number> {
  const print =
    deps.print ?? ((line: ReportLine): void => log[line.level](line.text));
  try {
    // Only the host starts a fusion (ADR-0019 section 11).
    if (env.sibling || env.fusionCandidate || env.fusionSynthesis) {
      throw new Error(
        'A fusion is started by the host only: a run that wants several opinions requests siblings (ADR-0013).'
      );
    }
    const prompt = fusePrompt(profileName, words);
    const root = findRoot(opts.dir);
    const found = (deps.findProfile ?? findFusionProfile)(profileName, root);
    const git = deps.git ?? new HostGit();
    if (!git.isRepo()) {
      throw new Error(
        'e fuse must run inside a git repository: every candidate is a run on its own branch of it.'
      );
    }
    const runtime = (deps.resolveRuntime ?? resolveRuntime)(opts.runtime);

    const storeDir = eBaseDir(root);
    const worktreesDir = deps.worktreesDir ?? defaultWorktreesDir();
    const launch = deps.launch ?? detachedLauncher;
    const passthroughArgs = fusePassthroughArgs(opts, runtime.engine);
    const keepSpool = opts.keepWorktree === true;
    const onEvent = (event: FuseEvent): void => {
      for (const line of fuseEventLines(event, found.profile)) print(line);
    };

    // The Store's loop caps derive the fusion's default deadlines (ADR-0019
    // section 9), so a candidate's own caps always fire first.
    const config = readConfig(root);
    const loop = config.loop;
    // The host-wide bound, shared with every other `e fuse` on this host
    // through the worktrees dir (ADR-0019 section 9).
    const limit = config.fusion.hostConcurrency;
    const hostSlots: HostSlots | undefined =
      limit !== undefined
        ? fileHostSlots(hostSlotsDir(worktreesDir), limit)
        : undefined;
    const fanOut = await (deps.fanOut ?? runFanOut)(
      {
        git,
        storeDir,
        worktreesDir,
        launch,
        passthroughArgs,
        keepSpool,
        ...(loop ? { loop } : {}),
        ...(hostSlots ? { hostSlots } : {}),
      },
      { found, prompt, abort: deps.abort, onEvent }
    );
    const synthesis =
      fanOut.state === 'fanning-out'
        ? await (deps.synthesis ?? runSynthesis)(
            { storeDir, worktreesDir, launch, passthroughArgs, keepSpool },
            { fanOut, abort: deps.abort, onEvent }
          )
        : undefined;
    const outcome: FuseOutcome = {
      fanOut,
      ...(synthesis ? { synthesis } : {}),
    };
    for (const line of fuseReport(outcome, found.profile, storeDir)) {
      print(line);
    }
    return fuseExitCode(outcome);
  } catch (err) {
    print({ level: 'error', text: errorMessage(err) });
    return 1;
  }
}

export function registerFuseCommand(program: Command): void {
  program
    .command('fuse')
    .description(
      'Run one task with every candidate Agent of a fusion profile, then synthesize one result (ADR-0019)'
    )
    .argument(
      '<profile>',
      'the fusion profile, .e/fusions/<profile>/fusion.json'
    )
    .argument('[prompt...]', 'the task every candidate gets (required)')
    .option(
      `${SPAWN_FLAGS.runtime} <runtime>`,
      `container runtime to use: ${RUNTIME_NAMES.join(', ')} (default: $E_RUNTIME, else the first one on PATH)`
    )
    .option(
      `${SPAWN_FLAGS.envFile} <path>`,
      'load environment variables from a file, for every run of the fusion'
    )
    .option(`${SPAWN_FLAGS.dir} <path>`, 'root directory holding the Store')
    .option(
      SPAWN_FLAGS.keepWorktree,
      "keep the fusion's spool and the runs' logs after it ends"
    )
    .action(
      async (profile: string, prompt: string[], opts: FuseCommandOptions) => {
        // Ctrl-C and SIGTERM are a cancel: every child is killed and tears
        // down, nothing more is pushed, exit 143 (ADR-0019 section 9). Should
        // that hang, the fallback still exits.
        const cancel = new AbortController();
        const live = new Set<ChildHandle>();
        const launch: ChildLauncher = l => {
          const child = detachedLauncher(l);
          live.add(child);
          void child.exited.then(() => live.delete(child));
          return child;
        };
        const onSignal = fuseCancelHandling({
          cancel,
          live: () => live,
          exit: code => process.exit(code),
          setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
          warn: text => log.warn(text),
        });
        process.on('SIGTERM', onSignal);
        process.on('SIGINT', onSignal);
        process.exit(
          await runFuseCommand(profile, prompt, opts, {
            abort: cancel.signal,
            launch,
          })
        );
      }
    );
}
