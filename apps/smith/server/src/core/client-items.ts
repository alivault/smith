/**
 * The items that one event stream's client holds, so a `state_sync` can be a
 * small patch (`itemsPatch`) instead of all items. The client changes its
 * items with `conversation_delta` operations between two syncs; this copy
 * applies them the same way as the web client
 * (`applyConversationDelta` in `src/lib/smith/sync.ts`). When an operation is
 * unknown, the next sync sends all items.
 */
import type {
  AssistantBlock,
  AssistantItem,
  ConversationItem,
  DeltaOperation,
} from "./items.ts"

type Operation = DeltaOperation | { op?: unknown }

/** The tool block of `callId` in `blocks` with the update, or undefined. */
function updateToolBlock(
  blocks: readonly AssistantBlock[],
  operation: Extract<DeltaOperation, { op: "updateTool" }>
) {
  const index = blocks.findIndex(
    (block) => block.type === "tool" && block.callId === operation.callId
  )
  const block = blocks[index]
  if (index < 0 || block?.type !== "tool") return undefined
  const isError = (operation as { isError?: unknown }).isError
  const next = [...blocks]
  next[index] = {
    ...block,
    ...(typeof operation.output === "string"
      ? { output: operation.output }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(operation, "details")
      ? { details: operation.details }
      : {}),
    ...(typeof isError === "boolean" ? { isError } : {}),
    running: operation.running,
  }
  return next
}

/** Put `block` at its key, or insert it at `contentIndex`. */
function placeBlock(
  blocks: readonly AssistantBlock[],
  block: AssistantBlock,
  contentIndex: number
) {
  const index = blocks.findIndex((entry) => entry.blockKey === block.blockKey)
  const next = [...blocks]
  if (index >= 0) next[index] = block
  else next.splice(Math.max(0, Math.min(contentIndex, next.length)), 0, block)
  return next
}

/**
 * Apply delta operations to the items as the web client does. Items that do
 * not change keep their identity. Undefined when an operation is unknown.
 */
export function applyClientDelta(
  items: readonly ConversationItem[],
  operations: readonly Operation[]
): ConversationItem[] | undefined {
  const streamingIndex = items.findLastIndex(
    (item) => item.kind === "assistant" && item.streaming
  )
  const current = items[streamingIndex]
  let assistant: AssistantItem =
    current?.kind === "assistant"
      ? current
      : {
          kind: "assistant",
          itemKey: "streaming",
          renderKey: "streaming",
          blocks: [],
          streaming: true,
          done: false,
        }
  let streamingTouched = false
  const next = [...items]

  for (const raw of operations) {
    const operation = raw as DeltaOperation
    if (operation.op === "updateTool") {
      if (streamingIndex >= 0 || streamingTouched) {
        const blocks = updateToolBlock(assistant.blocks, operation)
        if (blocks) {
          assistant = { ...assistant, blocks }
          streamingTouched = true
          continue
        }
      }
      for (let index = next.length - 1; index >= 0; index -= 1) {
        const item = next[index]
        if (index === streamingIndex || item?.kind !== "assistant") continue
        const blocks = updateToolBlock(item.blocks, operation)
        if (!blocks) continue
        next[index] = { ...item, blocks }
        break
      }
      continue
    }
    if (operation.op === "replaceItem") {
      streamingTouched = true
      assistant = operation.item
      continue
    }
    if (operation.op === "appendBlock") {
      streamingTouched = true
      const before = assistant.blocks.find(
        (block) => block.blockKey === operation.blockKey
      )
      // As the client: a new block with only these fields.
      const text =
        (before?.type === operation.blockType ? before.text : "") +
        operation.delta
      const block =
        operation.blockType === "text"
          ? ({ type: "text", blockKey: operation.blockKey, text } as const)
          : ({ type: "thinking", blockKey: operation.blockKey, text } as const)
      assistant = {
        ...assistant,
        blocks: placeBlock(assistant.blocks, block, operation.contentIndex),
      }
      continue
    }
    if (operation.op === "replaceBlock") {
      streamingTouched = true
      assistant = {
        ...assistant,
        blocks: placeBlock(
          assistant.blocks,
          operation.block,
          operation.contentIndex
        ),
      }
      continue
    }
    return undefined
  }

  if (streamingTouched) {
    const item: AssistantItem = { ...assistant, streaming: true, done: false }
    if (streamingIndex >= 0) next[streamingIndex] = item
    else next.push(item)
  }
  return next
}

/** A state sync whose items are a splice against what the client has. */
export function patchStateSync(
  previous: readonly unknown[],
  payload: Record<string, unknown>,
  next: readonly unknown[]
) {
  const same = (left: unknown, right: unknown) =>
    left === right || JSON.stringify(left) === JSON.stringify(right)
  let start = 0
  while (
    start < previous.length &&
    start < next.length &&
    same(previous[start], next[start])
  )
    start += 1
  let previousEnd = previous.length
  let nextEnd = next.length
  while (
    previousEnd > start &&
    nextEnd > start &&
    same(previous[previousEnd - 1], next[nextEnd - 1])
  ) {
    previousEnd -= 1
    nextEnd -= 1
  }
  const result: Record<string, unknown> = { ...payload }
  delete result.items
  result.itemsPatch = {
    previousLength: previous.length,
    start,
    deleteCount: previousEnd - start,
    items: next.slice(start, nextEnd),
  }
  for (const key of [
    "historyOffset",
    "historyTotalCount",
    "availableSkills",
    "firstMessage",
    "agentId",
    "agentFile",
    "cwd",
    "modified",
  ]) {
    delete result[key]
  }
  return result
}

/**
 * The state syncs of one stream: the first sync for an agent, and each sync
 * after the history window moves, carries all items; the others carry a
 * patch against the client's items.
 */
export class ClientItems {
  #items: unknown[] = []
  #agent: string | undefined
  #agentKey: unknown
  #historyOffset: unknown
  #stale = true

  /** The agent of the last sync. */
  get agent() {
    return this.#agent
  }

  /** The client got this full state (the bootstrap of the stream). */
  reset(payload: Record<string, unknown>) {
    this.#agent =
      typeof payload.agentId === "string" ? payload.agentId : undefined
    this.#agentKey = payload.agentKey
    this.#historyOffset = payload.historyOffset
    this.#items = Array.isArray(payload.items) ? payload.items : []
    this.#stale = false
  }

  /** The payload to send for a state sync with all items. */
  sync(payload: Record<string, unknown>) {
    const items = payload.items as unknown[]
    const agent =
      typeof payload.agentId === "string" ? payload.agentId : undefined
    if (
      this.#stale ||
      agent !== this.#agent ||
      payload.agentKey !== this.#agentKey ||
      payload.historyOffset !== this.#historyOffset
    ) {
      this.reset(payload)
      return payload
    }
    const patched = patchStateSync(this.#items, payload, items)
    this.#items = items
    return patched
  }

  /** The client applies these delta operations to its items. */
  delta(operations: readonly Operation[]) {
    if (this.#stale) return
    const next = applyClientDelta(this.#items as ConversationItem[], operations)
    if (next) this.#items = next
    else this.#stale = true
  }
}
