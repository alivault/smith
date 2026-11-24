import { describe, expect, test } from "vite-plus/test"

import { promptMarkdown } from "./prompt-markdown"

describe("promptMarkdown", () => {
  test("turns XML-like tags into inline code", () => {
    expect(promptMarkdown("<project_context>\nHello\n</project_context>")).toBe(
      "`<project_context>`\nHello\n`</project_context>`"
    )
    expect(promptMarkdown('<skill path="a/b.md"> <name>x</name>')).toBe(
      '`<skill path="a/b.md">` `<name>`x`</name>`'
    )
  })

  test("keeps code fences, inline code, and other text", () => {
    const fenced = "```html\n<div>\n```\nafter <b>"
    expect(promptMarkdown(fenced)).toBe("```html\n<div>\n```\nafter `<b>`")
    expect(promptMarkdown("Use `<tag>` here")).toBe("Use `<tag>` here")
    expect(promptMarkdown("a < b and 2 > 1, x<-y")).toBe(
      "a < b and 2 > 1, x<-y"
    )
    expect(promptMarkdown("**bold** and [link](https://a.b)")).toBe(
      "**bold** and [link](https://a.b)"
    )
  })
})
