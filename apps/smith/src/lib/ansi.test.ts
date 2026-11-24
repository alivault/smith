import { describe, expect, it } from "vite-plus/test"

import { ansiSegmentStyle, parseAnsiText } from "@/lib/ansi"

const ESC = "\u001b"

describe("parseAnsiText", () => {
  it("keeps plain text as one segment", () => {
    expect(parseAnsiText("hello\nworld")).toEqual([{ text: "hello\nworld" }])
  })

  it("applies colors and styles, and resets them", () => {
    const segments = parseAnsiText(`${ESC}[1;32mok${ESC}[0m done`)
    expect(segments).toEqual([
      {
        text: "ok",
        style: {
          bold: true,
          dim: false,
          italic: false,
          underline: false,
          foreground: "#22c55e",
        },
      },
      { text: " done" },
    ])
  })

  it("reads 256 and true colors", () => {
    const [color256, trueColor] = parseAnsiText(
      `${ESC}[38;5;196ma${ESC}[38;2;1;2;3mb`
    )
    expect(color256?.style?.foreground).toBe("rgb(255 0 0)")
    expect(trueColor?.style?.foreground).toBe("rgb(1 2 3)")
  })

  it("drops other control sequences", () => {
    expect(parseAnsiText(`a${ESC}[2Kb${ESC}]0;title\u0007c`)).toEqual([
      { text: "abc" },
    ])
  })
})

describe("ansiSegmentStyle", () => {
  it("maps a style to CSS", () => {
    expect(
      ansiSegmentStyle({
        bold: true,
        dim: true,
        italic: false,
        underline: true,
        foreground: "red",
      })
    ).toMatchObject({
      color: "red",
      fontWeight: 700,
      opacity: 0.72,
      textDecorationLine: "underline",
    })
    expect(ansiSegmentStyle(undefined)).toBeUndefined()
  })
})
