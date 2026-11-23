import { describe, expect, it } from "vite-plus/test"

import { parseGitCommitGraphLine } from "@/features/smith/right-sidebar-git-data"
import {
  gitSearchHighlightParts,
  gitSearchHighlightRanges,
  isGitCommitSearchMode,
  linearizeGitCommitLines,
} from "@/features/smith/right-sidebar-git-search"

describe("gitSearchHighlightRanges", () => {
  it("finds each match, ignoring case", () => {
    expect(gitSearchHighlightRanges("Fix the fix in FIX", "fix")).toEqual([
      [0, 3],
      [8, 11],
      [15, 18],
    ])
  })

  it("does not overlap matches", () => {
    expect(gitSearchHighlightRanges("aaaa", "aa")).toEqual([
      [0, 2],
      [2, 4],
    ])
  })

  it("treats the query as text, not a pattern", () => {
    expect(gitSearchHighlightRanges("a.b axb", "a.b")).toEqual([[0, 3]])
    expect(gitSearchHighlightRanges("run --all", "--all")).toEqual([[4, 9]])
  })

  it("gives nothing for an empty query or no match", () => {
    expect(gitSearchHighlightRanges("text", "  ")).toEqual([])
    expect(gitSearchHighlightRanges("text", "zzz")).toEqual([])
    expect(gitSearchHighlightRanges("", "a")).toEqual([])
  })

  it("trims the query", () => {
    expect(gitSearchHighlightRanges("Add search", " search ")).toEqual([
      [4, 10],
    ])
  })
})

describe("gitSearchHighlightParts", () => {
  it("cuts the text into matching and other parts", () => {
    expect(gitSearchHighlightParts("Add Search box", "search")).toEqual([
      { text: "Add ", match: false },
      { text: "Search", match: true },
      { text: " box", match: false },
    ])
    expect(gitSearchHighlightParts("plain", "x")).toEqual([
      { text: "plain", match: false },
    ])
  })
})

describe("isGitCommitSearchMode", () => {
  it("accepts only the known modes", () => {
    expect(isGitCommitSearchMode("message")).toBe(true)
    expect(isGitCommitSearchMode("file")).toBe(true)
    expect(isGitCommitSearchMode("regex")).toBe(false)
    expect(isGitCommitSearchMode(undefined)).toBe(false)
  })
})

describe("linearizeGitCommitLines", () => {
  const row = (hash: string, parents: string, subject: string) =>
    `${hash.slice(0, 7)}\t${hash}\u001f${parents}\u001fAli\u001f1 day ago\u001f2026-01-01T00:00:00Z\u001f${subject}`

  it("makes each row's parent the next row", () => {
    const a = "a".repeat(40)
    const b = "b".repeat(40)
    const c = "c".repeat(40)
    const lines = linearizeGitCommitLines([
      row(a, "f".repeat(40), "First"),
      row(b, `${"e".repeat(40)} ${"d".repeat(40)}`, "Second"),
      row(c, "9".repeat(40), "Third"),
    ])
    const parsed = lines.map(parseGitCommitGraphLine)
    expect(parsed.map((commit) => commit.parents)).toEqual([[b], [c], []])
    expect(parsed.map((commit) => commit.subject)).toEqual([
      "First",
      "Second",
      "Third",
    ])
    expect(parsed[0]?.author).toBe("Ali")
  })

  it("keeps rows without metadata", () => {
    expect(linearizeGitCommitLines(["| graph only"])).toEqual(["| graph only"])
  })
})
