import * as React from "react"

import type { AssistantItem, ConversationItem } from "@/lib/smith"
import {
  assistantMessageHasFooterMeta,
  assistantMessageHasVisibleBlocks,
  type AssistantMessagesSnapshot,
  type AssistantMessagesStore,
} from "@/features/smith/conversation-view"
import {
  conversationItemKey,
  sameConversationItemParts,
  segmentConversationItems,
  sliceAssistantItem,
  type ConversationItemPart,
} from "@/features/smith/conversation-segments"

export type RenderConversationGroupDescriptor =
  | {
      kind: "user"
      key: string
      itemKey: string
    }
  | {
      kind: "assistant"
      key: string
      /**
       * The row shows nothing, but stays in the list because an answered
       * question follows it (see `conversation-segments.ts`).
       */
      hidden?: boolean
    }
  | {
      // An answered question is a turn of the user: its own row, which the
      // scroller anchors to the top like a user message.
      kind: "question"
      key: string
      hidden: boolean
    }
  | {
      // A compaction summary is a turn boundary, so it gets its own row that
      // the scroller treats as a new turn. A pending row stands in for the
      // summary while compaction runs.
      kind: "compaction"
      key: string
      pending: boolean
    }

function partItems(
  parts: Array<ConversationItemPart>,
  getItem: (key: string) => ConversationItem | undefined
) {
  return parts.flatMap((part) => {
    const item = getItem(part.itemKey)
    return item?.kind === "assistant" ? [sliceAssistantItem(item, part)] : []
  })
}

export function groupConversationItemsForRender(options: {
  items: Array<ConversationItem>
  /** The items by key, when the caller has them. */
  itemByKey?: Map<string, ConversationItem>
  hideFooter: boolean
  hideThinking: boolean
  hideToolBlocks: boolean
}) {
  const groups: Array<RenderConversationGroupDescriptor> = []
  const segments = segmentConversationItems(options.items)
  if (segments.length === 0) return groups

  const itemByKey = options.itemByKey ?? buildConversationItemMap(options.items)
  const getItem = (key: string) => itemByKey.get(key)
  const hasVisibleBlocks = (item: AssistantItem) =>
    assistantMessageHasVisibleBlocks({
      item,
      hideThinking: options.hideThinking,
      hideToolBlocks: options.hideToolBlocks,
    })

  for (const segment of segments) {
    if (segment.kind === "user") {
      groups.push(segment)
      continue
    }

    if (segment.kind === "compaction") {
      groups.push({ kind: "compaction", key: segment.key, pending: false })
      continue
    }

    const items = partItems(segment.parts, getItem)

    if (segment.kind === "question") {
      groups.push({
        kind: "question",
        key: segment.key,
        hidden: !items.some(hasVisibleBlocks),
      })
      continue
    }

    const visible = items.some(
      (item) =>
        (!options.hideFooter && assistantMessageHasFooterMeta(item)) ||
        hasVisibleBlocks(item)
    )
    if (visible) {
      groups.push({ kind: "assistant", key: segment.key })
    } else if (segment.beforeQuestion) {
      groups.push({ kind: "assistant", key: segment.key, hidden: true })
    }
  }

  return groups
}

function sameRenderConversationGroupDescriptor(
  left: RenderConversationGroupDescriptor,
  right: RenderConversationGroupDescriptor
) {
  if (left.kind !== right.kind || left.key !== right.key) return false

  if (left.kind === "user" && right.kind === "user") {
    return left.itemKey === right.itemKey
  }

  if (left.kind === "compaction" && right.kind === "compaction") {
    return left.pending === right.pending
  }

  if (left.kind === "question" && right.kind === "question") {
    return left.hidden === right.hidden
  }

  return (
    left.kind === "assistant" &&
    right.kind === "assistant" &&
    Boolean(left.hidden) === Boolean(right.hidden)
  )
}

function reconcileRenderConversationGroupDescriptors(
  previousGroups: Array<RenderConversationGroupDescriptor>,
  nextGroups: Array<RenderConversationGroupDescriptor>
) {
  if (previousGroups.length === 0) return nextGroups

  let changed = previousGroups.length !== nextGroups.length
  const groups: Array<RenderConversationGroupDescriptor> = []

  for (let index = 0; index < nextGroups.length; index += 1) {
    const nextGroup = nextGroups[index]
    const previousGroup = previousGroups[index]

    if (
      previousGroup &&
      sameRenderConversationGroupDescriptor(previousGroup, nextGroup)
    ) {
      groups.push(previousGroup)
      continue
    }

    changed = true
    groups.push(nextGroup)
  }

  return changed ? groups : previousGroups
}

type ConversationItemsSnapshot = {
  items: Array<ConversationItem>
  itemByKey: Map<string, ConversationItem>
  revision: number
}

type ConversationGroupSubscription = {
  hideFooter: boolean
  hideThinking: boolean
  hideToolBlocks: boolean
  groups: Array<RenderConversationGroupDescriptor>
  listener: () => void
}

type ConversationGroupPartsSubscription = {
  groupKey: string
  parts: Array<ConversationItemPart>
  listener: () => void
}

const EMPTY_PARTS: Array<ConversationItemPart> = []

export type ConversationItemsStore = {
  getSnapshot: () => ConversationItemsSnapshot
  /** The item blocks that an assistant, question, or compaction row shows. */
  getGroupParts: (groupKey: string) => Array<ConversationItemPart>
  getItem: (key: string) => ConversationItem | undefined
  setItems: (items: Array<ConversationItem>) => void
  subscribe: (listener: () => void) => () => void
  subscribeGroups: (options: {
    hideFooter: boolean
    hideThinking: boolean
    hideToolBlocks: boolean
    groups: Array<RenderConversationGroupDescriptor>
    listener: () => void
  }) => () => void
  subscribeGroupParts: (groupKey: string, listener: () => void) => () => void
  subscribeItems: (keys: Array<string>, listener: () => void) => () => void
}

function buildConversationItemMap(items: Array<ConversationItem>) {
  const itemByKey = new Map<string, ConversationItem>()
  items.forEach((item, index) => {
    itemByKey.set(conversationItemKey(item, index), item)
  })
  return itemByKey
}

export function createConversationItemsStore(
  initialItems: Array<ConversationItem>
): ConversationItemsStore {
  let snapshot: ConversationItemsSnapshot = {
    items: initialItems,
    itemByKey: buildConversationItemMap(initialItems),
    revision: 0,
  }
  const listeners = new Set<() => void>()
  const itemListeners = new Map<string, Set<() => void>>()
  const groupSubscriptions = new Set<ConversationGroupSubscription>()
  const groupPartsSubscriptions = new Set<ConversationGroupPartsSubscription>()
  let partsRevision = -1
  let partsByGroup = new Map<string, Array<ConversationItemPart>>()

  const notifyItemListeners = (key: string) => {
    const listenersForItem = itemListeners.get(key)
    if (!listenersForItem) return

    for (const listener of listenersForItem) listener()
  }

  // The parts of each row, again after each change of the items. A row
  // keeps its parts array while its parts stay the same.
  const getGroupParts = (groupKey: string) => {
    if (partsRevision !== snapshot.revision) {
      const nextPartsByGroup = new Map<string, Array<ConversationItemPart>>()
      for (const segment of segmentConversationItems(snapshot.items)) {
        if (segment.kind === "user") continue
        const previous = partsByGroup.get(segment.key)
        nextPartsByGroup.set(
          segment.key,
          previous && sameConversationItemParts(previous, segment.parts)
            ? previous
            : segment.parts
        )
      }
      partsByGroup = nextPartsByGroup
      partsRevision = snapshot.revision
    }
    return partsByGroup.get(groupKey) ?? EMPTY_PARTS
  }

  return {
    getSnapshot: () => snapshot,
    getGroupParts,
    getItem: (key) => snapshot.itemByKey.get(key),
    setItems: (items) => {
      if (snapshot.items === items) return

      const previousItemByKey = snapshot.itemByKey
      const nextItemByKey = buildConversationItemMap(items)
      snapshot = {
        items,
        itemByKey: nextItemByKey,
        revision: snapshot.revision + 1,
      }

      const changedItemKeys = new Set<string>()
      for (const key of previousItemByKey.keys()) {
        if (previousItemByKey.get(key) !== nextItemByKey.get(key)) {
          changedItemKeys.add(key)
        }
      }
      for (const key of nextItemByKey.keys()) {
        if (previousItemByKey.get(key) !== nextItemByKey.get(key)) {
          changedItemKeys.add(key)
        }
      }

      for (const subscription of groupSubscriptions) {
        const nextGroups = groupConversationItemsForRender({
          items,
          itemByKey: nextItemByKey,
          hideFooter: subscription.hideFooter,
          hideThinking: subscription.hideThinking,
          hideToolBlocks: subscription.hideToolBlocks,
        })
        const groups = reconcileRenderConversationGroupDescriptors(
          subscription.groups,
          nextGroups
        )

        if (groups !== subscription.groups) {
          subscription.groups = groups
          subscription.listener()
        }
      }

      for (const subscription of groupPartsSubscriptions) {
        const nextParts = getGroupParts(subscription.groupKey)
        if (subscription.parts === nextParts) continue

        subscription.parts = nextParts
        subscription.listener()
      }

      for (const listener of listeners) listener()
      for (const key of changedItemKeys) notifyItemListeners(key)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    subscribeGroups: ({
      hideFooter,
      hideThinking,
      hideToolBlocks,
      groups,
      listener,
    }) => {
      const subscription: ConversationGroupSubscription = {
        hideFooter,
        hideThinking,
        hideToolBlocks,
        groups,
        listener,
      }
      groupSubscriptions.add(subscription)
      return () => {
        groupSubscriptions.delete(subscription)
      }
    },
    subscribeGroupParts: (groupKey, listener) => {
      const subscription: ConversationGroupPartsSubscription = {
        groupKey,
        parts: getGroupParts(groupKey),
        listener,
      }
      groupPartsSubscriptions.add(subscription)
      return () => {
        groupPartsSubscriptions.delete(subscription)
      }
    },
    subscribeItems: (keys, listener) => {
      const uniqueKeys = [...new Set(keys)]
      for (const key of uniqueKeys) {
        const listenersForItem = itemListeners.get(key) ?? new Set<() => void>()
        listenersForItem.add(listener)
        itemListeners.set(key, listenersForItem)
      }

      return () => {
        for (const key of uniqueKeys) {
          const listenersForItem = itemListeners.get(key)
          if (!listenersForItem) continue
          listenersForItem.delete(listener)
          if (listenersForItem.size === 0) {
            itemListeners.delete(key)
          }
        }
      }
    },
  }
}

export function useConversationRevision(store: ConversationItemsStore) {
  return React.useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().revision,
    () => store.getSnapshot().revision
  )
}

function conversationHasAssistantOutput(items: Array<ConversationItem>) {
  return items.some(
    (item) =>
      item.kind === "assistant" &&
      item.blocks.some(
        (block) =>
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim().length > 0
      )
  )
}

export function useConversationHasMessages(store: ConversationItemsStore) {
  return React.useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().items.length > 0,
    () => store.getSnapshot().items.length > 0
  )
}

export function useConversationHasAssistantOutput(
  store: ConversationItemsStore
) {
  return React.useSyncExternalStore(
    store.subscribe,
    () => conversationHasAssistantOutput(store.getSnapshot().items),
    () => conversationHasAssistantOutput(store.getSnapshot().items)
  )
}

export function useConversationGroupDescriptors({
  hideFooter,
  hideThinking,
  hideToolBlocks,
  store,
}: {
  hideFooter: boolean
  hideThinking: boolean
  hideToolBlocks: boolean
  store: ConversationItemsStore
}) {
  const cacheRef = React.useRef<{
    hideFooter: boolean
    hideThinking: boolean
    hideToolBlocks: boolean
    revision: number
    groups: Array<RenderConversationGroupDescriptor>
  }>({
    hideFooter,
    hideThinking,
    hideToolBlocks,
    revision: -1,
    groups: [],
  })

  const getSnapshot = () => {
    const snapshot = store.getSnapshot()
    const cache = cacheRef.current
    if (
      cache.revision === snapshot.revision &&
      cache.hideFooter === hideFooter &&
      cache.hideThinking === hideThinking &&
      cache.hideToolBlocks === hideToolBlocks
    ) {
      return cache.groups
    }

    const nextGroups = groupConversationItemsForRender({
      items: snapshot.items,
      itemByKey: snapshot.itemByKey,
      hideFooter,
      hideThinking,
      hideToolBlocks,
    })
    const groups =
      cache.hideFooter === hideFooter &&
      cache.hideThinking === hideThinking &&
      cache.hideToolBlocks === hideToolBlocks
        ? reconcileRenderConversationGroupDescriptors(cache.groups, nextGroups)
        : nextGroups

    cacheRef.current = {
      hideFooter,
      hideThinking,
      hideToolBlocks,
      revision: snapshot.revision,
      groups,
    }

    return groups
  }

  const subscribe = (listener: () => void) =>
    store.subscribeGroups({
      hideFooter,
      hideThinking,
      hideToolBlocks,
      groups: getSnapshot(),
      listener,
    })

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

type PendingCompactionRowState = {
  phase: "idle" | "pending" | "resolved"
  rowKey: string
  baselineKey: string | null
  /** The last group when the compaction began; the pending row stays after it. */
  afterKey: string | null
  count: number
  rowKeysByGroupKey: Map<string, string>
}

function lastCompactionGroupKey(
  groups: Array<RenderConversationGroupDescriptor>
) {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]
    if (group?.kind === "compaction") return group.key
  }
  return null
}

/**
 * Put the pending row after the group that was last when the compaction
 * began. A message sent while it runs comes below the row, as the last row,
 * so the scroller anchors it as a new turn and it stays in view.
 */
function withPendingRow(
  groups: Array<RenderConversationGroupDescriptor>,
  rowKey: string,
  afterKey: string | null
): Array<RenderConversationGroupDescriptor> {
  const row: RenderConversationGroupDescriptor = {
    kind: "compaction",
    key: rowKey,
    pending: true,
  }
  const index = afterKey
    ? groups.findIndex((group) => group.key === afterKey)
    : -1
  if (index < 0) return [...groups, row]
  return [...groups.slice(0, index + 1), row, ...groups.slice(index + 1)]
}

// While compaction runs, add a pending compaction row at the end. The
// summary that arrives takes over the row key of the pending row, so React
// keeps the same row element. The scroller anchors to the pending row as a
// new turn and then keeps the summary in that place.
//
// A compaction that starts while the agent runs (a background compaction)
// gets no pending row. The stream continues in the row above it, and the
// scroller would anchor to the pending row again on each resize, so the
// scroll position would reset while the answer streams. The working footer
// stays in the streaming row and shows the compaction state.
export function usePendingCompactionRow(
  groups: Array<RenderConversationGroupDescriptor>,
  compacting: boolean,
  streaming: boolean
) {
  const [storedState, setStoredState] =
    React.useState<PendingCompactionRowState>(() => ({
      phase: "idle",
      rowKey: "",
      baselineKey: null,
      afterKey: null,
      count: 0,
      rowKeysByGroupKey: new Map(),
    }))
  const lastKey = lastCompactionGroupKey(groups)

  // Derive the next state during render. React renders again at once when
  // the state changes, before it commits, so the row keys stay stable.
  let state = storedState
  if (state.phase === "idle" && compacting && !streaming) {
    const count = state.count + 1
    state = {
      ...state,
      count,
      phase: "pending",
      rowKey: `compaction-pending:${count}`,
      baselineKey: lastKey,
      afterKey: groups.at(-1)?.key ?? null,
    }
  }
  if (state.phase === "pending" && lastKey && lastKey !== state.baselineKey) {
    const rowKeysByGroupKey = new Map(state.rowKeysByGroupKey)
    rowKeysByGroupKey.set(lastKey, state.rowKey)
    state = { ...state, phase: "resolved", rowKeysByGroupKey }
  }
  if (state.phase !== "idle" && !compacting) {
    state = { ...state, phase: "idle" }
  }
  if (state !== storedState) {
    setStoredState(state)
  }

  const pendingRowKey = state.phase === "pending" ? state.rowKey : null
  const renderedGroups = pendingRowKey
    ? withPendingRow(groups, pendingRowKey, state.afterKey)
    : groups
  const rowKeysByGroupKey = state.rowKeysByGroupKey
  const rowKey = (group: RenderConversationGroupDescriptor) =>
    rowKeysByGroupKey.get(group.key) ?? group.key

  return { groups: renderedGroups, rowKey }
}

export function useConversationItem(
  store: ConversationItemsStore,
  key: string
): ConversationItem | undefined {
  return React.useSyncExternalStore(
    (listener) => store.subscribeItems([key], listener),
    () => store.getItem(key),
    () => store.getItem(key)
  )
}

export function assistantMessagesSnapshotFromStore(options: {
  hideThinking: boolean
  hideToolBlocks: boolean
  parts: Array<ConversationItemPart>
  store: ConversationItemsStore
}): AssistantMessagesSnapshot {
  return {
    hideThinking: options.hideThinking,
    hideToolBlocks: options.hideToolBlocks,
    items: partItems(options.parts, options.store.getItem),
  }
}

function sameAssistantMessagesSnapshot(
  left: AssistantMessagesSnapshot,
  right: AssistantMessagesSnapshot
) {
  if (left.hideThinking !== right.hideThinking) return false
  if (left.hideToolBlocks !== right.hideToolBlocks) return false
  if (left.items.length !== right.items.length) return false

  for (let index = 0; index < left.items.length; index += 1) {
    if (left.items[index] !== right.items[index]) return false
  }

  return true
}

export type MutableAssistantMessagesStore = AssistantMessagesStore & {
  setSnapshot: (snapshot: AssistantMessagesSnapshot) => void
}

export function createMutableAssistantMessagesStore(
  initialSnapshot: AssistantMessagesSnapshot
): MutableAssistantMessagesStore {
  let snapshot = initialSnapshot
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => snapshot,
    setSnapshot: (nextSnapshot) => {
      if (sameAssistantMessagesSnapshot(snapshot, nextSnapshot)) return

      snapshot = nextSnapshot
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
