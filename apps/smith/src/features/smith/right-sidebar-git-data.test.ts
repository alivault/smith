import { describe, expect, it } from "vite-plus/test"

import { parseGitCommitGraphLine } from "@/features/smith/right-sidebar-git-data"

const hash = "a".repeat(40)
const parent = "b".repeat(40)
const head = `aaaaaaa\t${hash}\u001f${parent}\u001fAli Abbas\u001f2 days ago\u001f2026-01-01T00:00:00Z`

describe("parseGitCommitGraphLine", () => {
  it("reads the email of newer servers", () => {
    const parsed = parseGitCommitGraphLine(
      `${head}\u001fFix <b> tags\u001f<ali@example.com>`
    )
    expect(parsed.subject).toBe("Fix <b> tags")
    expect(parsed.email).toBe("ali@example.com")
    expect(parsed.author).toBe("Ali Abbas")
    expect(parsed.parents).toEqual([parent])
    expect(parsed.stats).toBe("")
  })

  it("reads an empty email", () => {
    const parsed = parseGitCommitGraphLine(`${head}\u001fSubject\u001f<>`)
    expect(parsed.subject).toBe("Subject")
    expect(parsed.email).toBe("")
  })

  it("reads the rows of older servers, without an email", () => {
    const parsed = parseGitCommitGraphLine(`${head}\u001f<Subject>`)
    expect(parsed.subject).toBe("<Subject>")
    expect(parsed.email).toBe("")
    expect(parsed.fullDate).toBe("2026-01-01T00:00:00Z")
  })

  it("keeps a stats field before the email", () => {
    const parsed = parseGitCommitGraphLine(
      `${head}\u001fa\u001fb\u001fc\u001f<dev@example.com>`
    )
    expect(parsed.email).toBe("dev@example.com")
    // As before: the field before the email is a stats field.
    expect(parsed.stats).toBe("c")
    expect(parsed.subject).toBe("a\u001fb")
  })
})
