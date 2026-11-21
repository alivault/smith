import { describe, expect, it } from "vite-plus/test"

import {
  cacheNote,
  contextShare,
  formatTokens,
  methodLabel,
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

  it("words the cache note from the model's prices", () => {
    expect(cacheNote(tokensOf({ cacheRead: 0.1 }))).toBe(
      "Cached after the first request: later requests pay about 10% of the input price for it."
    )
    expect(cacheNote(tokensOf({ cacheRead: 0.25 }))).toContain("about 25%")
    expect(cacheNote(tokensOf({ cacheRead: 0.02 }))).toContain("about 2%")
    expect(cacheNote(tokensOf({ cacheRead: 0.005 }))).toContain("less than 1%")
    expect(cacheNote(tokensOf())).toBeUndefined()
  })

  it("names the method", () => {
    expect(methodLabel(tokensOf())).toMatch(/Exact/)
    expect(
      methodLabel(
        tokensOf({
          method: "estimate",
          total: count(10, false),
          note: "No Anthropic credentials",
        })
      )
    ).toBe(
      "Estimates (~): about 3.5 characters a token. No Anthropic credentials."
    )
  })
})
