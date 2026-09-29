import fs from 'fs';
import {
  triggerConfigPath,
  triggerPromptPath,
  triggersBaseDir,
} from '../store/paths.js';
import { errorMessage } from '../../shared/utils/errors.js';
import { parseTrigger, type Trigger, type TriggerContext } from './index.js';

/**
 * Reading the Store's triggers off disk (ADR-0016). One entry per directory
 * under `triggers/`, and **a broken one is an invalid entry, never a throw**:
 * a typo must not take down the BFF, the webhook listener and four healthy
 * triggers, and a detached `serve` that refuses to start is the least
 * diagnosable failure this system can produce. `e trigger list` renders these
 * errors, which is what makes that command the linter.
 */

/** One directory under `triggers/`: either a trigger, or why it is not one. */
export interface LoadedTrigger {
  /** The directory name, which is the trigger's id either way. */
  name: string;
  /** The parsed trigger, absent when it could not be read. */
  trigger?: Trigger;
  /** Why it could not be read, absent when it could. */
  error?: string;
}

/**
 * A Store's triggers as a long-lived reader - the scheduler, the listing
 * route - sees them: where they live, and what the Store knows, read afresh
 * at each load so an agent added under a running `serve` counts.
 */
export interface TriggerStore {
  root: string | undefined;
  context: () => TriggerContext;
}

/** Lists the trigger directory names, in directory order. */
export function listTriggerNames(root?: string): string[] {
  const dir = triggersBaseDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

/**
 * Parses one trigger from the text of its files, wherever they were read:
 * the Store on disk, or a commit (`git show`, the one-shot shape reading the
 * declaration from `base`). `promptMd` is `prompt.md`'s text when that file
 * exists. Any failure becomes a reason, never a throw.
 */
export function parseTriggerFiles(
  name: string,
  where: string,
  triggerJson: string,
  promptMd: string | undefined,
  context: TriggerContext = {}
): LoadedTrigger {
  try {
    const raw = JSON.parse(triggerJson) as Record<string, unknown>;
    if (promptMd !== undefined) {
      // "Instead of", not "as well as": two sources for one value drift, and
      // preferring one silently would make the other look applied.
      if (typeof raw.prompt === 'string' && raw.prompt !== '') {
        return {
          name,
          error: `${name} declares a prompt in trigger.json and in prompt.md; keep one`,
        };
      }
      raw.prompt = promptMd;
    }
    return { name, trigger: parseTrigger(raw, name, where, context) };
  } catch (err) {
    return { name, error: errorMessage(err) };
  }
}

/** Loads one trigger directory, turning any failure into a reason. */
export function loadTrigger(
  name: string,
  root?: string,
  context: TriggerContext = {}
): LoadedTrigger {
  const file = triggerConfigPath(name, root);
  try {
    if (!fs.existsSync(file)) {
      return { name, error: `no trigger.json in ${name}/` };
    }
    const promptFile = triggerPromptPath(name, root);
    return parseTriggerFiles(
      name,
      file,
      fs.readFileSync(file, 'utf8'),
      fs.existsSync(promptFile)
        ? fs.readFileSync(promptFile, 'utf8')
        : undefined,
      context
    );
  } catch (err) {
    return { name, error: errorMessage(err) };
  }
}

/** Loads every trigger directory in the Store. */
export function loadTriggers(
  root?: string,
  context: TriggerContext = {}
): LoadedTrigger[] {
  return listTriggerNames(root).map(name => loadTrigger(name, root, context));
}

/** One file's change marker: its mtime and size, `-` when it is absent. */
function fileSignature(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '-';
  }
}

/**
 * Each trigger directory's change marker, by name: the `serve` tick's mtime
 * scan (ADR-0016 section 8). A trigger whose marker changed is reloaded, so
 * an edit takes effect within one tick and no restart severs live runs.
 */
export function triggerSignatures(root?: string): Map<string, string> {
  return new Map(
    listTriggerNames(root).map(name => [
      name,
      `${fileSignature(triggerConfigPath(name, root))}|${fileSignature(triggerPromptPath(name, root))}`,
    ])
  );
}
