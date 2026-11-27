import { describe, expect, test } from "vite-plus/test"

import type { AssistantItem, ConversationItem } from "@/lib/smith"

import { groupConversationItemsForRender } from "./app-shell-conversation-store"
import {
  segmentConversationItems,
  sliceAssistantItem,
} from "./conversation-segments"

type Block = AssistantItem["blocks"][number]

const text = (value: string): Block => ({ type: "text", text: value })

const bash = (callId: string): Block => ({
  type: "tool",
  callId,
  name: "bash",
  args: { command: "ls" },
  output: "ok",
  isError: false,
  running: false,
})

function question(
  callId: string,
  state: "waiting" | "answered" | "cancelled"
): Block {
  return {
    type: "tool",
    callId,
    name: "ask_user",
    args: { question: "Which one?" },
    output:
      state === "answered"
        ? "The user answered: A"
        : state === "cancelled"
          ? "The user closed the question without an answer."
          : "",
    details: { questionId: callId, status: state },
    isError: state === "cancelled",
    running: state === "waiting",
  }
}

const user = (key: string, value = "hi"): ConversationItem => ({
  kind: "user",
  itemKey: key,
  text: value,
  images: [],
})

function assistant(
  key: string,
  blocks: Array<Block>,
  flags: Partial<AssistantItem> = {}
): AssistantItem {
  return { kind: "assistant", itemKey: key, blocks, ...flags }
}

function render(items: Array<ConversationItem>, hideToolBlocks = false) {
  return groupConversationItemsForRender({
    items,
    hideFooter: false,
    hideThinking: false,
    hideToolBlocks,
  })
}

describe("segmentConversationItems", () => {
  test("an open question stays in its assistant row", () => {
    const items = [
      user("u1"),
      assistant("a1", [text("Hi"), bash("b1")]),
      assistant("a2", [text("Ask"), question("q1", "waiting")]),
    ]
    expect(segmentConversationItems(items)).toEqual([
      { kind: "user", key: "u1", itemKey: "u1" },
      {
        kind: "assistant",
        key: "a1",
        parts: [
          { itemKey: "a1", start: 0, end: null },
          { itemKey: "a2", start: 0, end: null },
        ],
        beforeQuestion: false,
      },
    ])
  })

  test("a cancelled question stays in its assistant row", () => {
    const items = [
      user("u1"),
      assistant("a1", [text("Ask"), question("q1", "cancelled")]),
    ]
    expect(
      segmentConversationItems(items).map((segment) => segment.kind)
    ).toEqual(["user", "assistant"])
  })

  test("an answered question at the end of an item gets its own row", () => {
    const items = [
      user("u1"),
      assistant("a1", [text("Hi"), bash("b1")]),
      assistant("a2", [text("Report"), question("q1", "answered")]),
      assistant("a3", [text("Thanks")]),
    ]
    expect(segmentConversationItems(items)).toEqual([
      { kind: "user", key: "u1", itemKey: "u1" },
      {
        kind: "assistant",
        key: "a1",
        parts: [
          { itemKey: "a1", start: 0, end: null },
          { itemKey: "a2", start: 0, end: 1 },
        ],
        beforeQuestion: true,
      },
      {
        kind: "question",
        key: "question:q1",
        parts: [{ itemKey: "a2", start: 1, end: 2 }],
      },
      {
        kind: "assistant",
        key: "a3",
        parts: [{ itemKey: "a3", start: 0, end: null }],
        beforeQuestion: false,
      },
    ])
  })

  test("blocks after a question in the same item start a new row", () => {
    const items = [
      user("u1"),
      assistant("a1", [text("Ask"), question("q1", "answered"), bash("b2")]),
    ]
    expect(segmentConversationItems(items)).toEqual([
      { kind: "user", key: "u1", itemKey: "u1" },
      {
        kind: "assistant",
        key: "a1",
        parts: [{ itemKey: "a1", start: 0, end: 1 }],
        beforeQuestion: true,
      },
      {
        kind: "question",
        key: "question:q1",
        parts: [{ itemKey: "a1", start: 1, end: 2 }],
      },
      {
        kind: "assistant",
        key: "a1#from:2",
        parts: [{ itemKey: "a1", start: 2, end: null }],
        beforeQuestion: false,
      },
    ])
  })

  test("a question first in its row keeps an empty row before it", () => {
    const items = [user("u1"), assistant("a1", [question("q1", "answered")])]
    expect(segmentConversationItems(items)).toEqual([
      { kind: "user", key: "u1", itemKey: "u1" },
      {
        kind: "assistant",
        key: "a1",
        parts: [],
        beforeQuestion: true,
      },
      {
        kind: "question",
        key: "question:q1",
        parts: [{ itemKey: "a1", start: 0, end: 1 }],
      },
    ])
  })
})

describe("groupConversationItemsForRender", () => {
  test("rows keep their keys when the question is answered", () => {
    const before = render([
      user("u1"),
      assistant("a1", [text("Hi"), bash("b1")]),
      assistant("a2", [text("Report"), question("q1", "waiting")]),
    ])
    const after = render([
      user("u1"),
      assistant("a1", [text("Hi"), bash("b1")]),
      assistant("a2", [text("Report"), question("q1", "answered")]),
    ])
    const continued = render([
      user("u1"),
      assistant("a1", [text("Hi"), bash("b1")]),
      assistant("a2", [text("Report"), question("q1", "answered")]),
      assistant("a3", [text("Thanks")]),
    ])
    expect(before.map((group) => group.key)).toEqual(["u1", "a1"])
    // The question is a new row at the end, so the scroller anchors to it.
    expect(after.map((group) => group.key)).toEqual(["u1", "a1", "question:q1"])
    expect(continued.map((group) => group.key)).toEqual([
      "u1",
      "a1",
      "question:q1",
      "a3",
    ])
    expect(after[2]).toEqual({
      kind: "question",
      key: "question:q1",
      hidden: false,
    })
  })

  test("an empty row before a question stays, hidden", () => {
    const groups = render([
      user("u1"),
      assistant("a1", [question("q1", "answered")]),
    ])
    expect(groups).toEqual([
      { kind: "user", key: "u1", itemKey: "u1" },
      { kind: "assistant", key: "a1", hidden: true },
      { kind: "question", key: "question:q1", hidden: false },
    ])
  })

  test("hidden tool blocks hide the question row", () => {
    const groups = render(
      [
        user("u1"),
        assistant("a1", [text("Report"), question("q1", "answered")]),
        assistant("a2", [text("Thanks")]),
      ],
      true
    )
    expect(groups).toEqual([
      { kind: "user", key: "u1", itemKey: "u1" },
      { kind: "assistant", key: "a1" },
      { kind: "question", key: "question:q1", hidden: true },
      { kind: "assistant", key: "a2" },
    ])
  })
})

describe("sliceAssistantItem", () => {
  test("a part before a question is done and has no end time", () => {
    const item = assistant(
      "a1",
      [text("Report"), question("q1", "answered"), bash("b2")],
      { startedAt: 1000, endedAt: 900_000, done: false, streaming: true }
    )
    const before = sliceAssistantItem(item, { start: 0, end: 1 })
    expect(before.blocks).toEqual([text("Report")])
    expect(before.done).toBe(true)
    expect(before.streaming).toBe(false)
    expect(before.startedAt).toBe(1000)
    expect(before.endedAt).toBeUndefined()

    const after = sliceAssistantItem(item, { start: 2, end: null })
    expect(after.blocks).toEqual([bash("b2")])
    expect(after.startedAt).toBeUndefined()
    expect(after.endedAt).toBe(900_000)
  })

  test("the same part gives the same object", () => {
    const item = assistant("a1", [text("Report"), question("q1", "answered")])
    expect(sliceAssistantItem(item, { start: 0, end: 1 })).toBe(
      sliceAssistantItem(item, { start: 0, end: 1 })
    )
    expect(sliceAssistantItem(item, { start: 0, end: null })).toBe(item)
  })
})
