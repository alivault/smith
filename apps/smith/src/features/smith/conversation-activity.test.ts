import { describe, expect, test } from "vite-plus/test"

import type { AssistantItem, ConversationItem } from "@/lib/smith"

import { conversationShowsActivity } from "./conversation-activity"

const user: ConversationItem = { kind: "user", text: "hi", images: [] }

function assistant(
  blocks: AssistantItem["blocks"],
  flags: Partial<AssistantItem> = {}
): ConversationItem {
  return { kind: "assistant", blocks, ...flags }
}

const tool = (running: boolean) =>
  ({
    type: "tool",
    id: "t1",
    name: "bash",
    args: {},
    output: "",
    isError: false,
    running,
  }) as unknown as AssistantItem["blocks"][number]

describe("conversationShowsActivity", () => {
  test("a gap shows nothing by itself", () => {
    expect(conversationShowsActivity([])).toBe(false)
    expect(conversationShowsActivity([user])).toBe(false)
    expect(conversationShowsActivity([user, assistant([tool(false)])])).toBe(
      false
    )
    expect(
      conversationShowsActivity([
        user,
        assistant([{ type: "text", text: "" }], { streaming: true }),
      ])
    ).toBe(false)
  })

  test("a running tool, or streaming thinking or text, shows activity", () => {
    expect(conversationShowsActivity([user, assistant([tool(true)])])).toBe(
      true
    )
    expect(
      conversationShowsActivity([
        user,
        assistant([{ type: "thinking", text: "" }], { streaming: true }),
      ])
    ).toBe(true)
    expect(
      conversationShowsActivity([
        user,
        assistant([tool(false), { type: "text", text: "Done." }], {
          streaming: true,
        }),
      ])
    ).toBe(true)
  })

  test("a finished reply shows no activity", () => {
    expect(
      conversationShowsActivity([
        user,
        assistant([{ type: "text", text: "Done." }], { done: true }),
      ])
    ).toBe(false)
  })
})
