/**
 * Commander argument parser for a repeatable option that takes one value per
 * flag (`--skill a --skill b`). A variadic `<name...>` would instead swallow
 * every word up to the next flag, the prompt included, so
 * `e spawn pi --skill spawn-brother "do x"` read the prompt as a skill name.
 */
export function collectRepeatable(
  value: string,
  previous: string[] | undefined
): string[] {
  return [...(previous ?? []), value];
}
