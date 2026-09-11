import { ContainerRuntime } from './index.js';
import { Env } from '../utils/env.js';

/**
 * The **runtime registry**: every container engine `e` can drive, keyed by the
 * name `--runtime <name>` (or `E_RUNTIME`) accepts. Each name is also the
 * executable looked up on `PATH`, because all of them speak the Docker CLI
 * surface {@link ContainerRuntime} relies on (`run`, `build`, `network`,
 * `volume`, `exec`, `inspect`, `compose`). Desktop products are not entries of
 * their own: Docker Desktop, OrbStack, Colima, and Rancher Desktop (dockerd
 * mode) install a `docker` CLI; Podman Desktop installs `podman`; Rancher
 * Desktop in containerd mode and Lima expose `nerdctl`; Finch ships its own
 * nerdctl-based CLI. Engines with a different command surface (Apple's
 * `container`, Docker Sandboxes `sbx`) need an adapter of their own and are
 * deliberately not listed.
 */
export interface RuntimeDescriptor {
  /** The `--runtime` value and the executable on `PATH`. */
  name: string;
  /** Which products expose this CLI - shown in completions and help. */
  label: string;
}

/** Known runtimes, in auto-detection order (the first one found on `PATH` wins). */
export const RUNTIMES: readonly RuntimeDescriptor[] = [
  {
    name: 'docker',
    label:
      'Docker Engine, Docker Desktop, OrbStack, Colima, Rancher Desktop (dockerd)',
  },
  { name: 'podman', label: 'Podman, Podman Desktop' },
  {
    name: 'nerdctl',
    label: 'containerd via nerdctl (Rancher Desktop containerd mode, Lima)',
  },
  { name: 'finch', label: 'Finch (nerdctl-based, macOS and Windows)' },
];

/** The accepted `--runtime` values, in auto-detection order. */
export const RUNTIME_NAMES: readonly string[] = RUNTIMES.map(r => r.name);

/** True when `name` is a registered runtime. */
export function isRuntimeName(name: string): boolean {
  return RUNTIME_NAMES.includes(name);
}

/**
 * Picks the runtime to use, purely except for the injected availability
 * probe. `preferred` (the `--runtime` flag) wins, then `E_RUNTIME` from
 * `environment`; either must name a registered runtime that is installed.
 * Without a preference the registry is walked in order and the first
 * available runtime is returned. `create` builds the runtime for a command -
 * production passes the {@link ContainerRuntime} constructor, tests a fake
 * whose `isAvailable` they control.
 */
export function resolveRuntimeWith<T extends { isAvailable(): boolean }>(
  preferred: string | undefined,
  environment: Record<string, string | undefined>,
  create: (command: string) => T
): T {
  const requested = preferred ?? environment[Env.RUNTIME_VAR]?.trim();
  if (requested) {
    const source = preferred ? `--runtime` : Env.RUNTIME_VAR;
    if (!isRuntimeName(requested)) {
      throw new Error(
        `Invalid runtime "${requested}" (from ${source}). Valid values: ${RUNTIME_NAMES.join(', ')}.`
      );
    }
    const runtime = create(requested);
    if (!runtime.isAvailable()) {
      throw new Error(
        `Requested runtime "${requested}" (from ${source}) is not installed or not on PATH.`
      );
    }
    return runtime;
  }

  for (const { name } of RUNTIMES) {
    const runtime = create(name);
    if (runtime.isAvailable()) return runtime;
  }

  throw new Error(
    `No container runtime found. Install one of ${RUNTIME_NAMES.join(', ')} (Docker Desktop, Podman Desktop, OrbStack, Colima, Rancher Desktop, or Finch all provide one), or make sure it is on PATH.`
  );
}

/**
 * Resolves the {@link ContainerRuntime} for this process: `--runtime`, then
 * `E_RUNTIME`, then the first registered runtime found on `PATH`.
 */
export function resolveRuntime(
  preferred?: string,
  environment: Record<string, string | undefined> = process.env
): ContainerRuntime {
  return resolveRuntimeWith(
    preferred,
    environment,
    command => new ContainerRuntime(command)
  );
}
