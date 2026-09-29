/**
 * **Harness version pins** (ADR-0016 section 10). Unattended correctness rests
 * on specific argv - `codex exec --dangerously-bypass-approvals-and-sandbox`,
 * `opencode run --auto` - and a flag only means what it was verified to mean
 * against one version: the hazard is not a removed flag (that exits non-zero)
 * but a default moving beneath an unchanged one. So each harness carries an
 * exact version beside its argv, and the image says what it was built from.
 *
 * The pin reaches the image as build args, never as a literal in the
 * Dockerfile, because `e init` writes a Store's Dockerfile once and never
 * clobbers it; the image carries the args back out as labels, and the host
 * compares those labels against the pin before every spawn. Pure: the runtime
 * edge reads the labels and runs the build.
 */

/**
 * The `skills` CLI the Dockerfile installs skill collections with. Pinned,
 * being build tooling; the collections themselves stay unpinned (soft drift).
 */
// renovate: datasource=npm depName=skills
export const SKILLS_CLI_VERSION = '1.7.0';

/** The build args the harness Dockerfile declares (`ARG`), in the order it declares them. */
export const PIN_BUILD_ARGS = {
  package: 'HARNESS_PACKAGE',
  version: 'HARNESS_VERSION',
  skillsCli: 'SKILLS_CLI_VERSION',
} as const;

/** The image labels a pinned build carries, one per build arg. */
export const PIN_LABELS = {
  package: 'e.harness.package',
  version: 'e.harness.version',
  skillsCli: 'e.skills-cli.version',
} as const;

/** What a harness is pinned to: its npm package, exact version, and the skills CLI. */
export interface HarnessPin {
  package: string;
  version: string;
  skillsCli: string;
}

/** The pin of a harness: its npm package at the version its argv was verified against. */
export function harnessPin(harness: {
  version: string;
  dockerfile: { npmPackage: string };
}): HarnessPin {
  return {
    package: harness.dockerfile.npmPackage,
    version: harness.version,
    skillsCli: SKILLS_CLI_VERSION,
  };
}

/** The `--build-arg`s a pinned build passes. */
export function pinBuildArgs(pin: HarnessPin): Record<string, string> {
  return {
    [PIN_BUILD_ARGS.package]: pin.package,
    [PIN_BUILD_ARGS.version]: pin.version,
    [PIN_BUILD_ARGS.skillsCli]: pin.skillsCli,
  };
}

/** How an image's labels compare to the pin. */
export type PinCheck =
  | { status: 'match' }
  /** Built from a different package, version or skills CLI: `found` says which. */
  | { status: 'mismatch'; found: HarnessPin }
  /** Carries no pin labels at all: built before pinning, or from a Dockerfile without the `ARG`s. */
  | { status: 'unlabelled' };

/** Compares an image's labels against `pin`. */
export function checkPin(
  labels: Record<string, string>,
  pin: HarnessPin
): PinCheck {
  const found: Partial<HarnessPin> = {
    package: labels[PIN_LABELS.package] || undefined,
    version: labels[PIN_LABELS.version] || undefined,
    skillsCli: labels[PIN_LABELS.skillsCli] || undefined,
  };
  if (!found.package && !found.version && !found.skillsCli) {
    return { status: 'unlabelled' };
  }
  if (
    found.package === pin.package &&
    found.version === pin.version &&
    found.skillsCli === pin.skillsCli
  ) {
    return { status: 'match' };
  }
  return {
    status: 'mismatch',
    found: {
      package: found.package ?? '?',
      version: found.version ?? '?',
      skillsCli: found.skillsCli ?? '?',
    },
  };
}

/** `pkg@version` with the skills CLI beside it, as the messages spell a pin. */
function describe(pin: HarnessPin): string {
  return `${pin.package}@${pin.version} (skills CLI ${pin.skillsCli})`;
}

/** The announcement for a rebuild the pin forced, before it runs. */
export function pinRebuildMessage(
  imageTag: string,
  check: Exclude<PinCheck, { status: 'match' }>,
  pin: HarnessPin
): string {
  const was =
    check.status === 'unlabelled'
      ? 'carries no version labels'
      : `was built from ${describe(check.found)}`;
  return `Image ${imageTag} ${was}; the pin is ${describe(pin)}. Rebuilding it.`;
}

/**
 * The abort for an image that still does not carry the pin after it was just
 * built from the Store's Dockerfile: that Dockerfile predates the pin (or was
 * edited away from it), so another build would only repeat the result.
 */
export function unpinnedAfterBuildMessage(
  imageTag: string,
  dockerfile: string,
  check: Exclude<PinCheck, { status: 'match' }>,
  pin: HarnessPin
): string {
  const got =
    check.status === 'unlabelled'
      ? 'no version labels'
      : `the labels of ${describe(check.found)}`;
  return (
    `Image ${imageTag} was rebuilt and still carries ${got}, not ${describe(pin)}: ` +
    `${dockerfile} does not take the pinned version as build args. ` +
    `Run \`e init\` to re-seed a Dockerfile from before version pinning, ` +
    `or \`e init --force\` to replace a hand-edited one.`
  );
}
