import { describe, expect, test } from "vite-plus/test"

import {
  appendHeadPage,
  firstHeadPageRequest,
  hasFirstHistoryItem,
  historyGapCount,
  nextHeadPageRequest,
  olderTailPageRequest,
  prependTailPage,
  reconcileHistoryHead,
} from "@/features/smith/conversation-history-window"
import { updateStateFromSync } from "@/features/smith/app-shell-utils"
import type { AgentState, ConversationItem } from "@/lib/smith"
import { createInitialAgentState } from "@/lib/smith/sync"

function item(index: number): ConversationItem {
  return {
    kind: "user",
    itemKey: `item-${index}`,
    text: `Message ${index}`,
    images: [],
  } as ConversationItem
}

function range(start: number, end: number) {
  return Array.from({ length: end - start }, (_, index) => item(start + index))
}

function keys(items: Array<ConversationItem>) {
  return items.map((entry) => entry.itemKey)
}

describe("history gap", () => {
  test("counts the items between the head and the tail", () => {
    expect(historyGapCount(0, 1462)).toBe(0)
    expect(historyGapCount(50, 1462)).toBe(1412)
    expect(historyGapCount(50, 50)).toBe(0)
    expect(historyGapCount(60, 50)).toBe(0)
  })

  test("knows when the first item is loaded", () => {
    expect(hasFirstHistoryItem({ headItems: [], historyOffset: 0 })).toBe(true)
    expect(hasFirstHistoryItem({ headItems: [], historyOffset: 10 })).toBe(
      false
    )
    expect(
      hasFirstHistoryItem({ headItems: range(0, 5), historyOffset: 10 })
    ).toBe(true)
  })
})

describe("page requests", () => {
  test("the first page stops at the tail", () => {
    expect(
      firstHeadPageRequest({ headItems: [], historyOffset: 1462 })
    ).toEqual({ after: 0, limit: 50 })
    expect(firstHeadPageRequest({ headItems: [], historyOffset: 20 })).toEqual({
      after: 0,
      limit: 20,
    })
    expect(firstHeadPageRequest({ headItems: [], historyOffset: 0 })).toBe(null)
    expect(
      firstHeadPageRequest({ headItems: range(0, 5), historyOffset: 20 })
    ).toBe(null)
  })

  test("forward and older pages fill the gap and stop when it closes", () => {
    const window = { headItems: range(0, 50), historyOffset: 120 }
    expect(nextHeadPageRequest(window)).toEqual({ after: 50, limit: 50 })
    expect(olderTailPageRequest(window)).toEqual({ before: 120, limit: 50 })
    const small = { headItems: range(0, 50), historyOffset: 70 }
    expect(nextHeadPageRequest(small)).toEqual({ after: 50, limit: 20 })
    expect(olderTailPageRequest(small)).toEqual({ before: 70, limit: 20 })
    const closed = { headItems: range(0, 70), historyOffset: 70 }
    expect(nextHeadPageRequest(closed)).toBe(null)
    expect(olderTailPageRequest(closed)).toBe(null)
    expect(olderTailPageRequest({ headItems: [], historyOffset: 30 })).toEqual({
      before: 30,
      limit: 30,
    })
  })
})

describe("pages", () => {
  test("a forward page goes after the head and stops at the tail", () => {
    const window = { headItems: range(0, 50), historyOffset: 70 }
    const head = appendHeadPage(window, { offset: 50, items: range(50, 100) })
    expect(keys(head ?? [])).toEqual(keys(range(0, 70)))
  })

  test("a page that does not start at the end of the head is stale", () => {
    const window = { headItems: range(0, 50), historyOffset: 200 }
    expect(
      appendHeadPage(window, { offset: 40, items: range(40, 90) })
    ).toBeUndefined()
  })

  test("the first page makes the head", () => {
    const head = appendHeadPage(
      { headItems: [], historyOffset: 1462 },
      { offset: 0, items: range(0, 50) }
    )
    expect(keys(head ?? [])).toEqual(keys(range(0, 50)))
  })

  test("an older page goes before the tail without the head's items", () => {
    const tail = prependTailPage(
      { headItems: range(0, 60), items: range(100, 110), historyOffset: 100 },
      { offset: 50, items: range(50, 100) }
    )
    expect(tail.historyOffset).toBe(60)
    expect(keys(tail.items)).toEqual(keys(range(60, 110)))
  })

  test("an older page without a head goes before the tail", () => {
    const tail = prependTailPage(
      { headItems: [], items: range(100, 110), historyOffset: 100 },
      { offset: 50, items: range(50, 100) }
    )
    expect(tail.historyOffset).toBe(50)
    expect(keys(tail.items)).toEqual(keys(range(50, 110)))
  })
})

describe("head and tail", () => {
  test("the head ends at the tail", () => {
    const head = range(0, 50)
    expect(reconcileHistoryHead(head, 100, 200)).toBe(head)
    expect(keys(reconcileHistoryHead(head, 30, 200))).toEqual(
      keys(range(0, 30))
    )
  })

  test("the head goes when the tail has all items or the conversation is shorter", () => {
    const head = range(0, 50)
    expect(reconcileHistoryHead(head, 0, 200)).toEqual([])
    expect(reconcileHistoryHead(head, 10, 40)).toEqual([])
  })

  function longAgent(): AgentState {
    return {
      ...createInitialAgentState(),
      connected: true,
      draft: false,
      agentKey: "agent-a",
      agentId: "a",
      items: range(1362, 1462),
      historyOffset: 1362,
      historyTotalCount: 1462,
      headItems: range(0, 50),
    }
  }

  test("a sync of the tail keeps the head", () => {
    const state = longAgent()
    const next = updateStateFromSync(state, {
      type: "state_sync",
      agentKey: "agent-a",
      items: range(1363, 1463),
      historyOffset: 1363,
      historyTotalCount: 1463,
    })
    expect(next.headItems).toBe(state.headItems)
    expect(next.historyOffset).toBe(1362)
    expect(next.items.length).toBe(101)
  })

  test("another agent drops the head", () => {
    const next = updateStateFromSync(longAgent(), {
      type: "state_sync",
      agentKey: "agent-b",
      items: range(0, 10),
      historyOffset: 0,
      historyTotalCount: 10,
    })
    expect(next.headItems).toEqual([])
  })

  test("a shorter conversation drops the head", () => {
    const next = updateStateFromSync(longAgent(), {
      type: "state_sync",
      agentKey: "agent-a",
      items: range(0, 20),
      historyOffset: 0,
      historyTotalCount: 20,
    })
    expect(next.headItems).toEqual([])
  })
})
