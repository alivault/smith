import type {
  AssistantBlock,
  AssistantItem,
  ConversationItem,
} from "@/lib/smith"

/**
 * The rows of a conversation, before the visibility settings apply.
 *
 * An answered `ask_user` question is a turn of the user, like a user
 * message: it gets its own row, which the scroller anchors to the top. The
 * blocks before it stay in the assistant row above, and the blocks after it
 * start a new assistant row. An open or a closed question stays in its
 * assistant row.
 */

/** The blocks `[start, end)` of an item. `end: null` is to the last block. */
export type ConversationItemPart = {
  itemKey: string
  start: number
  end: number | null
}

export type ConversationSegment =
  | { kind: "user"; key: string; itemKey: string }
  | { kind: "compaction"; key: string; parts: Array<ConversationItemPart> }
  | {
      kind: "assistant"
      key: string
      parts: Array<ConversationItemPart>
      /**
       * An answered question comes after this row. The row stays in the list
       * also when it shows nothing, so the question row is a new row at the
       * end and the scroller sees it as a new turn.
       */
      beforeQuestion: boolean
    }
  | { kind: "question"; key: string; parts: Array<ConversationItemPart> }

export function conversationItemKey(item: ConversationItem, index: number) {
  return item.renderKey || item.itemKey || `message-row:${index}`
}

export function isCompactionItem(item: ConversationItem) {
  return (
    item.kind === "assistant" &&
    item.blocks.some((block) => block.type === "compaction")
  )
}

type QuestionDetails = { status?: unknown }

/** The same test as the question card (`agent/ask.tsx`). */
export function isAnsweredQuestionBlock(block: AssistantBlock) {
  if (block.type !== "tool" || block.name !== "ask_user") return false
  const details = block.details as QuestionDetails | undefined
  if (details?.status === "answered") return true
  return !block.running && !block.isError && details?.status !== "cancelled"
}

const answeredQuestionIndexesByItem = new WeakMap<
  AssistantItem,
  Array<number>
>()

function answeredQuestionIndexes(item: AssistantItem) {
  const cached = answeredQuestionIndexesByItem.get(item)
  if (cached) return cached

  const indexes: Array<number> = []
  item.blocks.forEach((block, index) => {
    if (isAnsweredQuestionBlock(block)) indexes.push(index)
  })
  answeredQuestionIndexesByItem.set(item, indexes)
  return indexes
}

function questionSegmentKey(
  item: AssistantItem,
  itemKey: string,
  index: number
) {
  const block = item.blocks[index]
  const callId = block?.type === "tool" ? block.callId : undefined
  return callId ? `question:${callId}` : `question:${itemKey}:${index}`
}

/** The key of an assistant row that starts at block `start` of an item. */
function assistantSegmentKey(itemKey: string, start: number) {
  return start === 0 ? itemKey : `${itemKey}#from:${start}`
}

const segmentsByItems = new WeakMap<
  Array<ConversationItem>,
  Array<ConversationSegment>
>()

export function segmentConversationItems(
  items: Array<ConversationItem>
): Array<ConversationSegment> {
  const cached = segmentsByItems.get(items)
  if (cached) return cached

  const segments: Array<ConversationSegment> = []
  let pending: Extract<ConversationSegment, { kind: "assistant" }> | null = null

  const flush = () => {
    if (pending) segments.push(pending)
    pending = null
  }

  const addPart = (part: ConversationItemPart) => {
    if (!pending) {
      pending = {
        kind: "assistant",
        key: assistantSegmentKey(part.itemKey, part.start),
        parts: [],
        beforeQuestion: false,
      }
    }
    pending.parts.push(part)
  }

  items.forEach((item, index) => {
    const key = conversationItemKey(item, index)

    if (item.kind === "user") {
      flush()
      segments.push({ kind: "user", key, itemKey: key })
      return
    }

    if (isCompactionItem(item)) {
      flush()
      segments.push({
        kind: "compaction",
        key,
        parts: [{ itemKey: key, start: 0, end: null }],
      })
      return
    }

    let start = 0
    for (const questionIndex of answeredQuestionIndexes(item)) {
      if (questionIndex > start) {
        addPart({ itemKey: key, start, end: questionIndex })
      }
      // Keep the row that held the question before the answer, also when
      // nothing is left in it.
      pending ??= {
        kind: "assistant",
        key: assistantSegmentKey(key, start),
        parts: [],
        beforeQuestion: false,
      }
      pending.beforeQuestion = true
      flush()
      segments.push({
        kind: "question",
        key: questionSegmentKey(item, key, questionIndex),
        parts: [{ itemKey: key, start: questionIndex, end: questionIndex + 1 }],
      })
      start = questionIndex + 1
    }

    if (start === 0 || start < item.blocks.length) {
      addPart({ itemKey: key, start, end: null })
    }
  })

  flush()
  segmentsByItems.set(items, segments)
  return segments
}

const slicedItemsByItem = new WeakMap<
  AssistantItem,
  Map<string, AssistantItem>
>()

/**
 * The blocks of a part, as an item. A part before or at a question is done:
 * its response ended when the user answered. It gets no end time, because
 * the end time of the item includes the wait for the answer. A part after a
 * question gets no start time, for the same reason. The result is the same
 * object for the same item and part, so snapshots can compare items.
 */
export function sliceAssistantItem(
  item: AssistantItem,
  part: Pick<ConversationItemPart, "start" | "end">
): AssistantItem {
  if (part.start === 0 && part.end === null) return item

  const cacheKey = `${part.start}:${part.end ?? ""}`
  let cache = slicedItemsByItem.get(item)
  const cached = cache?.get(cacheKey)
  if (cached) return cached

  const sliced: AssistantItem = {
    ...item,
    blocks: item.blocks.slice(part.start, part.end ?? undefined),
  }
  if (part.end !== null) {
    sliced.done = true
    sliced.streaming = false
    delete sliced.endedAt
  }
  if (part.start > 0) delete sliced.startedAt

  if (!cache) {
    cache = new Map()
    slicedItemsByItem.set(item, cache)
  }
  cache.set(cacheKey, sliced)
  return sliced
}

export function sameConversationItemParts(
  left: Array<ConversationItemPart>,
  right: Array<ConversationItemPart>
) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    if (a.itemKey !== b.itemKey || a.start !== b.start || a.end !== b.end) {
      return false
    }
  }
  return true
}
