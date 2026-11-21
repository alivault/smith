/** Pure helpers of the Scratchpad section (`scratch.tsx`). */

export type ScratchEntry = {
  id: string
  name: string
  bytes: number
  lines: number
  createdAt: number
  source?: string
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function scratchEntriesFrom(state: Record<string, unknown> | undefined) {
  const entries = state?.scratch
  return Array.isArray(entries) ? (entries as Array<ScratchEntry>) : []
}

/**
 * The state without some scratch entries (`ids`), or without all of them, to
 * show a delete at once.
 */
export function withoutScratchEntries<T extends Record<string, unknown>>(
  state: T,
  ids: ReadonlySet<string> | "all"
): T {
  const left =
    ids === "all"
      ? []
      : scratchEntriesFrom(state).filter((entry) => !ids.has(entry.id))
  const next: Record<string, unknown> = { ...state }
  // The server leaves out an empty scratchpad.
  if (left.length > 0) next.scratch = left
  else delete next.scratch
  return next as T
}

/** The text of the confirm dialog of Clear. */
export function clearScratchDescription(count: number) {
  return count === 1
    ? "This deletes 1 saved output. The agent can no longer read it."
    : `This deletes ${count} saved outputs. The agent can no longer read them.`
}
