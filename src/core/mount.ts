/**
 * A bind mount as structured data, so callers describe *what* to mount and the
 * runtime owns the `host:container[:ro]` argv format (rather than each caller
 * hand-concatenating the string). `ro` defaults to read-write when omitted.
 *
 * It lives in `core` rather than with the container runtime that formats it
 * because planning code (skills, MCP, the spawn plan) describes mounts long
 * before a runtime is chosen, and `core` sits below `ports`.
 */
export interface Mount {
  /** Host path to mount. */
  host: string;
  /** Container path it appears at. */
  container: string;
  /** Mount read-only (`:ro`); omit or false for read-write. */
  ro?: boolean;
}
