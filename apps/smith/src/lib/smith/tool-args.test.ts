import { describe, expect, test } from "vite-plus/test"

import { rawShellCommandTextFromTool, searchToolSummary } from "./tool-args"

describe("searchToolSummary", () => {
  test("a search shows its pattern, path, and options", () => {
    expect(
      searchToolSummary("grep", {
        pattern: "TODO",
        path: "src/lib",
        glob: "*.ts",
        limit: 20,
      })
    ).toBe("TODO in src/lib · glob=*.ts · limit=20")
    expect(searchToolSummary("grep", { pattern: "a  b" })).toBe("a b")
    expect(searchToolSummary("rg", { query: "foo", path: "." })).toBe(
      "foo in ."
    )
    expect(searchToolSummary("find", { pattern: "*.md", path: "docs" })).toBe(
      "*.md in docs"
    )
    expect(searchToolSummary("glob", { pattern: "**/*.tsx" })).toBe("**/*.tsx")
  })

  test("a list shows its folder, or the current folder", () => {
    expect(searchToolSummary("ls", { path: "src", limit: 50 })).toBe(
      "src · limit=50"
    )
    expect(searchToolSummary("ls", {})).toBe(".")
  })

  test("a shell call shows its command, also while it streams", () => {
    expect(searchToolSummary("bash", { command: "rg -n\n  foo src" })).toBe(
      "rg -n foo src"
    )
    expect(searchToolSummary("bash", '{"command":"rg -n fo')).toBe("rg -n fo")
  })

  test("no summary without arguments, or for other tools", () => {
    expect(searchToolSummary("grep", undefined)).toBe("")
    expect(searchToolSummary("ls", undefined)).toBe("")
    expect(searchToolSummary("bash", undefined)).toBe("")
    expect(searchToolSummary("read", { path: "a.ts" })).toBe("")
  })
})

describe("rawShellCommandTextFromTool", () => {
  test("reads the command of complete and partial arguments", () => {
    expect(rawShellCommandTextFromTool("bash", { command: "ls" })).toBe("ls")
    expect(rawShellCommandTextFromTool("bash", '{"command":"ls -l"}')).toBe(
      "ls -l"
    )
    expect(rawShellCommandTextFromTool("bash", '{"command":"ls -')).toBe("ls -")
    expect(rawShellCommandTextFromTool("read", { command: "ls" })).toBe("")
  })
})
