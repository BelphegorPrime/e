/**
 * Local AI runtimes which `e init` can provision.  Add a definition here, then
 * teach the compose/bootstrap renderers about it; the init decision flow stays
 * a generic multi-select.
 */
export const LOCAL_RUNTIMES = [{ id: 'llamacpp', label: 'llama.cpp' }] as const;

export type LocalRuntime = (typeof LOCAL_RUNTIMES)[number]['id'];

export function isLocalRuntime(value: unknown): value is LocalRuntime {
  return (
    typeof value === 'string' &&
    LOCAL_RUNTIMES.some(runtime => runtime.id === value)
  );
}
