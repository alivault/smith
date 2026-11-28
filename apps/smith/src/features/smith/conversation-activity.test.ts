import { describe, expect, test } from "vite-plus/test"

import type { ConversationItem } from "@/lib/smith"

import { turnAwaitsFirstOutput } from "./conversation-activity"

const user: ConversationItem = { kind: "user", text: "hi", images: [] }
const reply: ConversationItem = {
  kind: "assistant",
  blocks: [{ type: "text", text: "Done." }],
}

describe("turnAwaitsFirstOutput", () => {
  test("true until the turn has output", () => {
    expect(turnAwaitsFirstOutput([])).toBe(false)
    expect(turnAwaitsFirstOutput([user])).toBe(true)
    expect(turnAwaitsFirstOutput([user, reply])).toBe(false)
    expect(turnAwaitsFirstOutput([user, reply, user])).toBe(true)
  })
})
