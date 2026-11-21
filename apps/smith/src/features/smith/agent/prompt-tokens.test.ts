import { describe, expect, it } from "vite-plus/test"

import {
  cacheShare,
  contextShare,
  formatTokens,
  methodLabel,
  promptFooter,
  shareWidths,
  type PromptTokens,
} from "./prompt-tokens"

const count = (tokens: number, exact = true) => ({ tokens, exact })

function tokensOf(extra: Partial<PromptTokens> = {}): PromptTokens {
  return {
    method: "exact",
    pending: false,
    parts: {},
    prompt: count(4100),
    tools: { total: count(6300), items: [] },
    total: count(10_400),
    ...extra,
  }
}

describe("prompt token counts", () => {
  it("formats counts short, with ~ for estimates", () => {
    expect(formatTokens(count(840))).toBe("840")
    expect(formatTokens(count(1000))).toBe("1k")
    expect(formatTokens(count(1234))).toBe("1.2k")
    expect(formatTokens(count(12_345, false))).toBe("~12k")
    expect(formatTokens(count(1_500_000))).toBe("1.5M")
  })

  it("gives the share of the context window", () => {
    expect(contextShare(4000, 200_000)).toBe("2%")
    expect(contextShare(100, 200_000)).toBe("<1%")
    expect(contextShare(100, undefined)).toBeUndefined()
  })

  it("words the cache share from the model's prices", () => {
    expect(cacheShare(tokensOf({ cacheRead: 0.1 }))).toBe("about 10%")
    expect(cacheShare(tokensOf({ cacheRead: 0.25 }))).toBe("about 25%")
    expect(cacheShare(tokensOf({ cacheRead: 0.02 }))).toBe("about 2%")
    expect(cacheShare(tokensOf({ cacheRead: 0.005 }))).toBe("less than 1%")
    expect(cacheShare(tokensOf())).toBeUndefined()
  })

  it("names the method", () => {
    expect(methodLabel(tokensOf())).toBe("Exact counts from Anthropic")
    expect(
      methodLabel(
        tokensOf({
          method: "estimate",
          total: count(10, false),
          note: "No Anthropic credentials",
        })
      )
    ).toBe("Estimates (~): no Anthropic credentials")
  })

  it("writes the footer of the prompt group", () => {
    expect(promptFooter(undefined)).toBe("In the order the agent gets them.")
    expect(promptFooter(tokensOf({ cacheRead: 0.1 }))).toBe(
      "In the order the agent gets them. Exact counts from Anthropic; cached at about 10% of the input price after the first request."
    )
    expect(
      promptFooter(tokensOf({ pending: true, total: count(10, false) }))
    ).toBe(
      "In the order the agent gets them. Estimates (~) until Anthropic counts them."
    )
  })
})

describe("share bar widths", () => {
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

  it("is proportional when every part is large enough", () => {
    expect(shareWidths([1, 1, 2])).toEqual([25, 25, 50])
  })

  it("gives small parts the minimum width", () => {
    const widths = shareWidths([1, 10_000, 9_999])
    expect(widths[0]).toBe(2)
    expect(sum(widths)).toBeCloseTo(100)
    expect(widths[1]).toBeGreaterThan(widths[2])
  })

  it("gives empty parts no width", () => {
    expect(shareWidths([0, 5, 5])).toEqual([0, 50, 50])
    expect(shareWidths([0, 0])).toEqual([0, 0])
    expect(shareWidths([])).toEqual([])
  })

  it("raises parts that scaling pushes under the minimum", () => {
    const widths = shareWidths([1, 1, 2.1, 95.9], 3)
    expect(widths.slice(0, 3)).toEqual([3, 3, 3])
    expect(sum(widths)).toBeCloseTo(100)
  })

  it("shares the bar equally when the minimums fill it", () => {
    expect(shareWidths([1, 1, 98], 40)).toEqual([100 / 3, 100 / 3, 100 / 3])
  })
})
