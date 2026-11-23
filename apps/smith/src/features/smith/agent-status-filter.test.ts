import { describe, expect, it } from "vite-plus/test"

import { withBusyAgents } from "@/features/smith/agent-status-filter"

describe("withBusyAgents", () => {
  const keys = ["a", "b", "c", "d", "e"]

  it("keeps the first agents and adds busy ones further down", () => {
    expect(withBusyAgents(keys, 2, ["d"])).toEqual(["a", "b", "d"])
  })

  it("does not repeat a busy agent that already shows", () => {
    expect(withBusyAgents(keys, 2, ["a", "e"])).toEqual(["a", "b", "e"])
  })

  it("shows all when the count covers the list", () => {
    expect(withBusyAgents(keys, 9, [])).toBe(keys)
  })
})
