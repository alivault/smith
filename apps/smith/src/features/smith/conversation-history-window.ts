import type { ConversationItem } from "@/lib/smith"

// The loaded conversation has up to two parts:
// - the head: items [0, headItems.length), loaded by a jump to the first
//   message and by forward pages,
// - the tail: items [historyOffset, total), the live window. It gets the
//   streaming updates and older pages.
// Between them is a gap of items that are not loaded. When the gap closes
// (head end >= historyOffset), the two parts are one contiguous list: the
// head keeps only the items before the tail, and the view shows no gap row.
// The head rows are not moved into the tail, so the rows do not remount and
// the view does not jump.

export const HISTORY_PAGE_SIZE = 50

/** A page load: back from the tail, the first page, or forward in the head. */
export type HistoryLoadKind = "older" | "first" | "forward"

export type HistoryWindow = {
  headItems: Array<ConversationItem>
  historyOffset: number
}

export type HistoryPage = {
  offset: number
  items: Array<ConversationItem>
}

/** The number of items between a head of `headCount` items and the tail. */
export function historyGapCount(headCount: number, historyOffset: number) {
  if (headCount === 0) return 0
  return Math.max(0, historyOffset - headCount)
}

/** Whether the first item of the conversation is loaded. */
export function hasFirstHistoryItem(window: HistoryWindow) {
  return window.historyOffset === 0 || window.headItems.length > 0
}

/**
 * The head that fits the tail: it ends at or before `historyOffset`, and it
 * goes when the conversation got shorter than it (for example a new
 * conversation in the same view) or when the tail holds all items.
 */
export function reconcileHistoryHead(
  headItems: Array<ConversationItem>,
  historyOffset: number,
  totalCount: number
) {
  if (headItems.length === 0) return headItems
  if (historyOffset <= 0 || totalCount < headItems.length) return []
  return headItems.length > historyOffset
    ? headItems.slice(0, historyOffset)
    : headItems
}

/**
 * The `after` and `limit` of the first page, when the first item is not
 * loaded.
 */
export function firstHeadPageRequest(
  window: HistoryWindow,
  pageSize = HISTORY_PAGE_SIZE
) {
  if (hasFirstHistoryItem(window)) return null
  return { after: 0, limit: Math.min(pageSize, window.historyOffset) }
}

/** The `after` and `limit` of the next forward page of the head. */
export function nextHeadPageRequest(
  window: HistoryWindow,
  pageSize = HISTORY_PAGE_SIZE
) {
  const after = window.headItems.length
  const limit = Math.min(pageSize, window.historyOffset - after)
  return limit > 0 ? { after, limit } : null
}

/** The `before` and `limit` of the next older page of the tail. */
export function olderTailPageRequest(
  window: HistoryWindow,
  pageSize = HISTORY_PAGE_SIZE
) {
  const before = window.historyOffset
  const limit = Math.min(pageSize, before - window.headItems.length)
  return limit > 0 ? { before, limit } : null
}

/**
 * Add a forward page to the head. Returns undefined when the page does not
 * start at the end of the head, for example because the head changed while
 * the request ran.
 */
export function appendHeadPage(window: HistoryWindow, page: HistoryPage) {
  if (page.offset !== window.headItems.length) return undefined
  const room = Math.max(0, window.historyOffset - page.offset)
  const items = page.items.slice(0, room)
  return items.length > 0 ? [...window.headItems, ...items] : window.headItems
}

/**
 * Add an older page before the tail. Items that the head holds already are
 * left out.
 */
export function prependTailPage(
  window: HistoryWindow & { items: Array<ConversationItem> },
  page: HistoryPage
) {
  const skip = Math.max(0, window.headItems.length - page.offset)
  const items = page.items.slice(skip)
  return {
    items: [...items, ...window.items],
    historyOffset: page.offset + skip,
  }
}
