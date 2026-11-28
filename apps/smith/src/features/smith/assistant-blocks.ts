import type { ConversationItem } from "@/lib/smith"

export type AssistantConversationBlock = Extract<
  ConversationItem,
  { kind: "assistant" }
>["blocks"][number]

/** One row of an assistant message: each visible block has its own row. */
export type AssistantBlockDescriptor = {
  key: string
  blockType: AssistantConversationBlock["type"]
}

function toolArgsKey(args: unknown) {
  if (typeof args === "string") return args
  if (args == null) return ""

  try {
    return JSON.stringify(args)
  } catch {
    return ""
  }
}

export function assistantBlockKey(block: AssistantConversationBlock) {
  switch (block.type) {
    case "text":
      return `text:${block.text}`
    case "thinking":
      return `thinking:${block.text}`
    case "tool":
      return `tool:${block.callId || block.name || "tool"}:${toolArgsKey(block.args)}`
    case "compaction":
      return `compaction:${block.tokensBefore}:${block.estimatedTokensAfter ?? ""}:${block.summary}`
    default:
      return "block"
  }
}

/**
 * React keys for the visible blocks of a message group. Keys do not include
 * the block position, so a block keeps its key when blocks before it appear
 * or disappear. The position only separates duplicate keys.
 */
export function assistantBlockRenderKeys(
  blocks: Array<AssistantConversationBlock>
) {
  const seen = new Set<string>()
  return blocks.map((block, index) => {
    const baseKey =
      block.renderKey || block.blockKey || assistantBlockKey(block)
    const key = seen.has(baseKey) ? `${baseKey}:${index}` : baseKey
    seen.add(key)
    return key
  })
}

/**
 * True when a block shows. A tool call shows as soon as it starts to
 * stream, also before its name or arguments are complete.
 */
export function assistantBlockIsVisible({
  block,
  hideToolBlocks,
}: {
  block: AssistantConversationBlock
  hideThinking: boolean
  hideToolBlocks: boolean
}) {
  switch (block.type) {
    case "text":
      return Boolean(block.text.trim())
    case "compaction":
      return true
    case "thinking":
      // Hidden thinking shows as a collapsed row.
      return Boolean(block.text.trim())
    case "tool":
      return !hideToolBlocks
    default:
      return false
  }
}

export function assistantBlockDescriptors(
  blocks: Array<AssistantConversationBlock>,
  keys: Array<string>
): Array<AssistantBlockDescriptor> {
  return blocks.map((block, index) => ({
    key: keys[index]!,
    blockType: block.type,
  }))
}

function sameAssistantBlockDescriptor(
  left: AssistantBlockDescriptor,
  right: AssistantBlockDescriptor
) {
  return left.key === right.key && left.blockType === right.blockType
}

/**
 * The next descriptors, with the previous objects where they did not change,
 * and the previous array when nothing changed. So rows do not render again
 * while the message streams.
 */
export function reconcileAssistantBlockDescriptors(
  previousGroups: Array<AssistantBlockDescriptor>,
  nextGroups: Array<AssistantBlockDescriptor>
) {
  if (previousGroups.length === 0) return nextGroups

  let changed = previousGroups.length !== nextGroups.length
  const groups: Array<AssistantBlockDescriptor> = []

  for (let index = 0; index < nextGroups.length; index += 1) {
    const previousGroup = previousGroups[index]
    const nextGroup = nextGroups[index]

    if (
      previousGroup &&
      nextGroup &&
      sameAssistantBlockDescriptor(previousGroup, nextGroup)
    ) {
      groups.push(previousGroup)
      continue
    }

    changed = true
    groups.push(nextGroup)
  }

  return changed ? groups : previousGroups
}
