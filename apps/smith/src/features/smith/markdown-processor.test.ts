import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import Markdown, { type Components, type ExtraProps } from "react-markdown"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import { describe, expect, it } from "vite-plus/test"

import {
  markdownMayHaveHtml,
  renderMarkdown,
} from "@/features/smith/markdown-processor"

const SCHEMA = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "obsidian"],
  },
}

/** Components that show each node's source position, as the app reads it. */
function positioned(tag: string) {
  return function Positioned({
    children,
    node,
    ...props
  }: { children?: ReactNode } & ExtraProps) {
    return createElement(
      tag,
      {
        ...props,
        "data-start": node?.position?.start.offset,
        "data-end": node?.position?.end.offset,
      },
      children
    )
  }
}

const COMPONENTS: Components = {
  a: positioned("a"),
  code: positioned("code"),
  pre: positioned("pre"),
  p: positioned("p"),
  td: positioned("td"),
  li: positioned("li"),
}

const SAMPLES = {
  prose:
    "# Title\n\nSome *em* and **strong** text with `code`.\n\nNext line\nsame paragraph.",
  lists:
    "- one\n- two `x`\n  - nested\n\n1. first\n2. second [link](https://example.com)",
  fence:
    "Before\n\n```ts\nconst a = 1 < 2\nexport function f() {}\n```\n\nAfter",
  openFence: "Streaming\n\n```py\nprint('hi')",
  table:
    "| Step | Result |\n| --- | :-: |\n| Build | 40 modules |\n| Test | `ok` |",
  rawHtml:
    'Text <b>bold</b> and <span style="color:red">red</span>\n\n<details><summary>More</summary>\n\nHidden *md*\n\n</details>',
  unsafe:
    '<script>alert(1)</script> <a href="javascript:alert(1)">x</a> [y](javascript:alert(1))',
  autolink: "See <https://example.com> and www.example.org and a@b.co",
  appLink: "[note](obsidian://open?vault=v) and [file](file:///tmp/a.txt)",
  entities: "a &lt; b &amp; c &copy; 1 > 0",
  task: "- [ ] todo\n- [x] done",
  footnote: "Text[^1]\n\n[^1]: The note.",
  blocks:
    '> quote\n> more\n\n---\n\n![alt](https://example.com/a.png "t") ~~gone~~\n\n## H2\n\n    indented code',
  tableInList: "1. Item\n\n   | a | b |\n   | - | - |\n   | 1 | 2 |\n\n2. Next",
  twoTables: "| a |\n| - |\n| 1 |\n\ntext\n\n| b | c |\n| - | - |\n| 2 | 3 |",
} as const

function reference(text: string, breaks: boolean) {
  return renderToStaticMarkup(
    createElement(Markdown, {
      children: text,
      components: COMPONENTS,
      rehypePlugins: [rehypeRaw, [rehypeSanitize, SCHEMA]],
      remarkPlugins: breaks ? [remarkGfm, remarkBreaks] : [remarkGfm],
    })
  )
}

function fast(text: string, breaks: boolean, raw?: boolean) {
  return renderToStaticMarkup(
    renderMarkdown(text, {
      breaks,
      components: COMPONENTS,
      sanitizeSchema: SCHEMA,
      ...(raw === undefined ? {} : { raw }),
    })
  )
}

describe("renderMarkdown", () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    for (const breaks of [false, true]) {
      it(`renders ${name}${breaks ? " with breaks" : ""} as react-markdown`, () => {
        const expected = reference(text, breaks)
        expect(fast(text, breaks)).toBe(expected)
        // With or without the fast path (no rehype-raw without "<").
        expect(fast(text, breaks, true)).toBe(expected)
        if (!markdownMayHaveHtml(text))
          expect(fast(text, breaks, false)).toBe(expected)
      })
    }
  }

  it("reuses its processor: a second render gives the same output", () => {
    const text = SAMPLES.table
    expect(fast(text, false)).toBe(fast(text, false))
  })
})
