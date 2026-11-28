import { describe, expect, it } from "vite-plus/test"

import type { AssistantItem, ConversationItem, ToolBlock } from "@/lib/smith"
import { applyConversationDelta, buildItemsFromSync } from "@/lib/smith/sync"

function tool(callId: string, output = ""): ToolBlock {
  return {
    type: "tool",
    blockKey: `entry:2:tool:${callId}`,
    callId,
    name: "bash",
    args: {},
    output,
    isError: false,
    running: true,
  }
}

function committedItems(): Array<ConversationItem> {
  return [
    {
      kind: "user",
      itemKey: "entry:1",
      text: "run it",
      images: [],
    } as ConversationItem,
    {
      kind: "assistant",
      itemKey: "entry:2",
      blocks: [
        { type: "text", blockKey: "entry:2:text:0", text: "Running" },
        tool("call-a"),
        tool("call-b"),
      ],
      streaming: false,
      done: true,
    },
  ]
}

const update = (callId: string, output: string) => ({
  type: "conversation_delta" as const,
  agentId: "s1",
  operations: [{ op: "updateTool" as const, callId, output, running: true }],
})

describe("applyConversationDelta with updateTool", () => {
  it("updates a tool block in a committed item", () => {
    const items = committedItems()
    const next = applyConversationDelta(items, update("call-b", "line 1\n"))

    // No streaming item is made for a tool update.
    expect(next).toHaveLength(2)
    expect(next[0]).toBe(items[0])
    const before = items[1] as AssistantItem
    const after = next[1] as AssistantItem
    expect(after).not.toBe(before)
    expect(after.streaming).toBe(false)
    expect(after.blocks[0]).toBe(before.blocks[0])
    expect(after.blocks[1]).toBe(before.blocks[1])
    expect(after.blocks[2]).toMatchObject({
      callId: "call-b",
      output: "line 1\n",
      running: true,
    })
  })

  it("updates a tool block in the streaming item", () => {
    const streaming: AssistantItem = {
      kind: "assistant",
      itemKey: "streaming",
      renderKey: "streaming",
      blocks: [tool("call-c")],
      streaming: true,
      done: false,
    }
    const items = [...committedItems(), streaming]
    const next = applyConversationDelta(items, update("call-c", "out"))

    expect(next).toHaveLength(3)
    expect(next[1]).toBe(items[1])
    expect((next[2] as AssistantItem).blocks[0]).toMatchObject({
      output: "out",
    })
  })

  it("keeps the items when no tool block has the call", () => {
    const items = committedItems()
    expect(applyConversationDelta(items, update("call-x", "out"))).toBe(items)
  })
})

describe("buildItemsFromSync", () => {
  it("keeps the streaming row when its answer commits into a full history window", () => {
    const committed = (n: number): ConversationItem => ({
      kind: "assistant",
      itemKey: `entry:${n}`,
      blocks: [
        { type: "text", blockKey: `entry:${n}:text`, text: `reply ${n}` },
      ],
      streaming: false,
      done: true,
    })
    const tool = (blockKey: string, running: boolean) =>
      ({
        type: "tool",
        blockKey,
        callId: "call-1",
        name: "bash",
        args: { command: "ls" },
        output: "",
        isError: false,
        running,
      }) as ToolBlock
    const window = Array.from({ length: 100 }, (_, i) => committed(i))
    const streaming: AssistantItem = {
      kind: "assistant",
      itemKey: "streaming",
      renderKey: "message:100",
      blocks: [tool("streaming:tool:call-1", true)],
      streaming: true,
      done: false,
    }
    const previous = [...window, streaming]
    // The window moves by one: the oldest item goes, the answer commits.
    const next: ConversationItem[] = [
      ...window.slice(1),
      {
        kind: "assistant",
        itemKey: "entry:100",
        blocks: [tool("entry:100:tool:call-1", true)],
        streaming: false,
        done: true,
      },
    ]
    const { items } = buildItemsFromSync(
      { type: "state_sync", streaming: true, items: next } as never,
      previous
    )
    const last = items.at(-1) as AssistantItem
    expect(last.itemKey).toBe("entry:100")
    expect(last.renderKey).toBe("message:100")
    const block = last.blocks[0] as ToolBlock
    expect(block.renderKey ?? block.blockKey).toBe("streaming:tool:call-1")
  })
})
