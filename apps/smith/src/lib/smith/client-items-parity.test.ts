/**
 * The server keeps a copy of each client's items (`applyClientDelta` in
 * `server/src/core/client-items.ts`), so a state sync can be a patch. The
 * copy must change the same way as the client's items here.
 */
import { describe, expect, it } from "vite-plus/test"

import { applyClientDelta } from "../../../server/src/core/client-items.ts"
import type { ConversationDeltaEvent, ConversationItem } from "@/lib/smith"
import { applyConversationDelta } from "@/lib/smith/sync"

type Operations = ConversationDeltaEvent["operations"]

/** The items without `renderKey`: only the client sets it. */
function comparable(items: Array<ConversationItem>) {
  return JSON.parse(
    JSON.stringify(items, (key, value: unknown) =>
      key === "renderKey" ? undefined : value
    )
  ) as unknown
}

const committed: Array<ConversationItem> = [
  { kind: "user", itemKey: "entry:1", text: "go", images: [] },
  {
    kind: "assistant",
    itemKey: "entry:2",
    blocks: [
      {
        type: "tool",
        blockKey: "entry:2:tool:a",
        callId: "a",
        name: "bash",
        args: {},
        output: "",
        isError: false,
        running: true,
      },
    ],
    streaming: false,
    done: true,
  },
]

const steps: Array<Operations> = [
  [{ op: "updateTool", callId: "a", output: "line 1\n", running: true }],
  [
    {
      op: "appendBlock",
      contentIndex: 0,
      blockKey: "s:thinking:0",
      blockType: "thinking",
      delta: "Let me ",
    },
  ],
  [
    {
      op: "appendBlock",
      contentIndex: 0,
      blockKey: "s:thinking:0",
      blockType: "thinking",
      delta: "think.",
    },
    {
      op: "appendBlock",
      contentIndex: 1,
      blockKey: "s:text:1",
      blockType: "text",
      delta: "Hello",
    },
  ],
  [
    {
      op: "replaceBlock",
      contentIndex: 1,
      block: { type: "text", blockKey: "s:text:1", text: "Hello there" },
    },
  ],
  [
    {
      op: "replaceBlock",
      contentIndex: 2,
      block: {
        type: "tool",
        blockKey: "s:tool:b",
        callId: "b",
        name: "bash",
        args: { command: "ls" },
        output: "",
        isError: false,
        running: true,
      },
    },
  ],
  [{ op: "updateTool", callId: "b", output: "file\n", running: true }],
  [
    {
      op: "updateTool",
      callId: "a",
      output: "line 1\nline 2\n",
      running: false,
    },
  ],
  [
    {
      op: "replaceItem",
      item: {
        kind: "assistant",
        itemKey: "streaming",
        renderKey: "streaming",
        blocks: [{ type: "text", blockKey: "s:text:0", text: "New" }],
        streaming: true,
        done: false,
      },
    },
  ],
  [
    {
      op: "appendBlock",
      contentIndex: 0,
      blockKey: "s:text:0",
      blockType: "text",
      delta: " answer",
    },
  ],
]

describe("the server's copy of the client items", () => {
  it("changes the same way as the client's items", () => {
    let client = committed
    let server: Array<ConversationItem> = committed
    for (const operations of steps) {
      client = applyConversationDelta(client, {
        type: "conversation_delta",
        agentId: "s1",
        operations,
      })
      const next = applyClientDelta(server as never, operations as never)
      expect(next).toBeDefined()
      server = next as unknown as Array<ConversationItem>
      expect(comparable(server)).toEqual(comparable(client))
    }
  })
})
