import { describe, expect, test } from "vite-plus/test"

import {
  assistantBlockDescriptors,
  assistantBlockIsVisible,
  assistantBlockRenderKeys,
  reconcileAssistantBlockDescriptors,
  type AssistantConversationBlock,
} from "./assistant-blocks"

function tool(
  callId: string,
  name: string | undefined,
  args: unknown,
  running = false
): AssistantConversationBlock {
  return {
    type: "tool",
    blockKey: `m1:tool:${callId}`,
    callId,
    ...(name ? { name } : {}),
    args,
    output: "",
    isError: false,
    running,
  }
}

const turn: Array<AssistantConversationBlock> = [
  tool("c1", "read", { path: "src/a.ts" }),
  tool("c2", "grep", { pattern: "TODO", path: "src" }),
  tool("c3", "bash", { command: "rg -n foo" }),
  tool("c4", "bash", { command: "pnpm test" }),
  { type: "text", text: "Done." },
]

const visible = (
  blocks: Array<AssistantConversationBlock>,
  hideToolBlocks = false
) =>
  blocks.filter((block) =>
    assistantBlockIsVisible({ block, hideThinking: false, hideToolBlocks })
  )

describe("assistant block rows", () => {
  test("each explore call has its own row, as other tool calls", () => {
    const keys = assistantBlockRenderKeys(turn)
    expect(assistantBlockDescriptors(turn, keys)).toEqual([
      { key: "m1:tool:c1", blockType: "tool" },
      { key: "m1:tool:c2", blockType: "tool" },
      { key: "m1:tool:c3", blockType: "tool" },
      { key: "m1:tool:c4", blockType: "tool" },
      { key: "text:Done.", blockType: "text" },
    ])
  })

  test("a tool call shows as soon as it starts to stream", () => {
    expect(visible([tool("c5", "bash", '{"command":"r', true)])).toHaveLength(1)
    expect(visible([tool("c6", "bash", undefined, true)])).toHaveLength(1)
    expect(visible([tool("c7", undefined, undefined, true)])).toHaveLength(1)
  })

  test("hidden tool blocks hide all tool calls", () => {
    expect(visible(turn, true)).toEqual([turn[4]])
  })

  test("rows keep their objects while a call streams", () => {
    const streaming = [tool("c1", "read", { path: "src/a.ts" }, true)]
    const first = assistantBlockDescriptors(
      streaming,
      assistantBlockRenderKeys(streaming)
    )
    const finished = [tool("c1", "read", { path: "src/a.ts" })]
    const same = reconcileAssistantBlockDescriptors(
      first,
      assistantBlockDescriptors(finished, assistantBlockRenderKeys(finished))
    )
    expect(same).toBe(first)

    const next = [...finished, tool("c2", "grep", { pattern: "x" }, true)]
    const grown = reconcileAssistantBlockDescriptors(
      first,
      assistantBlockDescriptors(next, assistantBlockRenderKeys(next))
    )
    expect(grown[0]).toBe(first[0])
    expect(grown).toHaveLength(2)
  })
})
