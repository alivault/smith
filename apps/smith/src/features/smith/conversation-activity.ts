import type { ConversationItem } from "@/lib/smith"

/**
 * True while the turn has no output yet: the last item is the user's
 * message (or a notice that wakes the agent). Then nothing in the
 * conversation shows that the agent works, so the "Working…" line shows.
 * After the first output, the steps of the turn show the work.
 */
export function turnAwaitsFirstOutput(items: readonly ConversationItem[]) {
  return items.at(-1)?.kind === "user"
}
