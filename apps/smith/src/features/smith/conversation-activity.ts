import type { ConversationItem } from "@/lib/smith"

/**
 * True when the end of the conversation shows by itself that the agent
 * works: a tool call runs (its line has a spinner), or the reply streams
 * thinking or text now. Then the "Working…" line is not necessary. It shows
 * only in the gaps: before the first output, and while the model has not
 * started its next output after a tool call.
 */
export function conversationShowsActivity(items: readonly ConversationItem[]) {
  const last = items.at(-1)
  if (!last || last.kind !== "assistant") return false
  if (last.blocks.some((block) => block.type === "tool" && block.running))
    return true
  if (!last.streaming || last.done) return false
  const block = last.blocks.at(-1)
  if (!block) return false
  if (block.type === "thinking") return true
  return block.type === "text" && block.text.trim().length > 0
}
