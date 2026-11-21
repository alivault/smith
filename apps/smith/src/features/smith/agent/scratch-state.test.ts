import { describe, expect, it } from "vite-plus/test"

import {
  clearScratchDescription,
  formatBytes,
  scratchEntriesFrom,
  withoutScratchEntries,
} from "./scratch-state"

const entry = (id: string) => ({
  id,
  name: id,
  bytes: 1,
  lines: 1,
  createdAt: 0,
})

describe("scratch state", () => {
  it("removes one entry and keeps the rest of the state", () => {
    const state = { todo: { items: [] }, scratch: [entry("a"), entry("b")] }
    expect(withoutScratchEntries(state, new Set(["a"]))).toEqual({
      todo: { items: [] },
      scratch: [entry("b")],
    })
    expect(state.scratch).toHaveLength(2)
  })

  it("drops the key when no entry is left", () => {
    expect(withoutScratchEntries({ scratch: [entry("a")] }, "all")).toEqual({})
    expect(
      withoutScratchEntries({ scratch: [entry("a")] }, new Set(["a"]))
    ).toEqual({})
  })

  it("reads entries from any state", () => {
    expect(scratchEntriesFrom(undefined)).toEqual([])
    expect(scratchEntriesFrom({ scratch: "x" })).toEqual([])
  })

  it("formats sizes and the confirm text", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB")
    expect(clearScratchDescription(1)).toBe(
      "This deletes 1 saved output. The agent can no longer read it."
    )
    expect(clearScratchDescription(4)).toBe(
      "This deletes 4 saved outputs. The agent can no longer read them."
    )
  })
})
