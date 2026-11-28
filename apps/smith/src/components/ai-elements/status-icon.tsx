export type TraceStatus = "running" | "error" | undefined

/**
 * The status of a Trace line, from its flags. A running line has a shimmering
 * title, and a failed line is red; a line has no status icon.
 */
export function traceStatus(running: boolean, isError: boolean): TraceStatus {
  return running ? "running" : isError ? "error" : undefined
}
