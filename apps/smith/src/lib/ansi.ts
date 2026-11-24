import type * as React from "react"

/**
 * Parses terminal output with ANSI escape sequences into styled text
 * segments: SGR colors and styles (16, 256, and true colors) apply, other
 * control sequences drop out.
 */
export type AnsiStyleState = {
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  foreground?: string
  background?: string
}

export type AnsiTextSegment = {
  text: string
  style?: AnsiStyleState
}

type ParsedAnsiSequence = {
  kind: "sgr" | "control"
  end: number
  params?: string
}

const ANSI_16_COLORS = [
  "#3f3f46",
  "#ef4444",
  "#22c55e",
  "#eab308",
  "#3b82f6",
  "#d946ef",
  "#06b6d4",
  "#e4e4e7",
  "#71717a",
  "#f87171",
  "#4ade80",
  "#facc15",
  "#60a5fa",
  "#e879f9",
  "#22d3ee",
  "#fafafa",
] as const

function defaultAnsiStyle(): AnsiStyleState {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    // Set, so a reset (ESC [0m) clears the colors too.
    foreground: undefined,
    background: undefined,
  }
}

function cloneAnsiStyle(style: AnsiStyleState): AnsiStyleState | undefined {
  if (
    !style.bold &&
    !style.dim &&
    !style.italic &&
    !style.underline &&
    !style.foreground &&
    !style.background
  ) {
    return undefined
  }

  return { ...style }
}

function ansiStyleKey(style?: AnsiStyleState) {
  if (!style) return ""
  return [
    style.bold ? "1" : "0",
    style.dim ? "1" : "0",
    style.italic ? "1" : "0",
    style.underline ? "1" : "0",
    style.foreground || "",
    style.background || "",
  ].join(";")
}

function pushAnsiTextSegment(
  segments: Array<AnsiTextSegment>,
  text: string,
  style: AnsiStyleState
) {
  if (!text) return

  const nextStyle = cloneAnsiStyle(style)
  const previous = segments[segments.length - 1]

  if (previous && ansiStyleKey(previous.style) === ansiStyleKey(nextStyle)) {
    previous.text += text
    return
  }

  segments.push({ text, style: nextStyle })
}

function parseAnsiSequence(
  text: string,
  index: number
): ParsedAnsiSequence | null {
  const charCode = text.charCodeAt(index)
  const isEsc = charCode === 0x1b
  const isCsi = charCode === 0x9b

  if (!isEsc && !isCsi) return null

  if (isCsi) {
    return parseAnsiCsiSequence(text, index, index + 1)
  }

  const introducer = text[index + 1]

  if (introducer === "[") {
    return parseAnsiCsiSequence(text, index, index + 2)
  }

  if (introducer === "]") {
    const bellEnd = text.indexOf("\u0007", index + 2)
    const stEnd = text.indexOf("\u001b\\", index + 2)
    const candidates = [bellEnd, stEnd].filter((value) => value >= 0)
    const end = candidates.length > 0 ? Math.min(...candidates) : -1

    if (end < 0) {
      return { kind: "control", end: index + 2 }
    }

    return {
      kind: "control",
      end: end === stEnd ? end + 2 : end + 1,
    }
  }

  return { kind: "control", end: Math.min(text.length, index + 2) }
}

function parseAnsiCsiSequence(
  text: string,
  start: number,
  paramsStart: number
): ParsedAnsiSequence | null {
  for (let index = paramsStart; index < text.length; index += 1) {
    const code = text.charCodeAt(index)

    if (code >= 0x40 && code <= 0x7e) {
      const final = text[index]
      return {
        kind: final === "m" ? "sgr" : "control",
        end: index + 1,
        params: text.slice(paramsStart, index),
      }
    }
  }

  return { kind: "control", end: start + 1 }
}

function parseAnsiSgrParams(params = "") {
  if (!params) return [0]

  return params
    .replace(/:/g, ";")
    .split(";")
    .map((param) => {
      if (!param || param.startsWith("?")) return 0
      const value = Number(param)
      return Number.isFinite(value) ? value : 0
    })
}

function ansi256ToCss(value: number | undefined) {
  if (typeof value !== "number") return undefined
  if (value >= 0 && value < 16) return ANSI_16_COLORS[value]

  if (value >= 16 && value <= 231) {
    const offset = value - 16
    const red = Math.floor(offset / 36)
    const green = Math.floor((offset % 36) / 6)
    const blue = offset % 6
    const toChannel = (channel: number) =>
      channel === 0 ? 0 : 55 + channel * 40

    return `rgb(${toChannel(red)} ${toChannel(green)} ${toChannel(blue)})`
  }

  if (value >= 232 && value <= 255) {
    const channel = 8 + (value - 232) * 10
    return `rgb(${channel} ${channel} ${channel})`
  }
}

function readAnsiExtendedColor(codes: Array<number>, index: number) {
  const mode = codes[index + 1]

  if (mode === 5) {
    return {
      color: ansi256ToCss(codes[index + 2]),
      nextIndex: index + 2,
    }
  }

  if (mode === 2) {
    const red = codes[index + 2]
    const green = codes[index + 3]
    const blue = codes[index + 4]

    if ([red, green, blue].every((value) => value >= 0 && value <= 255)) {
      return {
        color: `rgb(${red} ${green} ${blue})`,
        nextIndex: index + 4,
      }
    }
  }

  return { color: undefined, nextIndex: index }
}

function applyAnsiSgrCodes(style: AnsiStyleState, codes: Array<number>) {
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index]

    if (code === 0) {
      Object.assign(style, defaultAnsiStyle())
      continue
    }

    if (code === 1) {
      style.bold = true
      continue
    }

    if (code === 2) {
      style.dim = true
      continue
    }

    if (code === 3) {
      style.italic = true
      continue
    }

    if (code === 4) {
      style.underline = true
      continue
    }

    if (code === 22) {
      style.bold = false
      style.dim = false
      continue
    }

    if (code === 23) {
      style.italic = false
      continue
    }

    if (code === 24) {
      style.underline = false
      continue
    }

    if (code === 39) {
      style.foreground = undefined
      continue
    }

    if (code === 49) {
      style.background = undefined
      continue
    }

    if (code >= 30 && code <= 37) {
      style.foreground = ANSI_16_COLORS[code - 30]
      continue
    }

    if (code >= 40 && code <= 47) {
      style.background = ANSI_16_COLORS[code - 40]
      continue
    }

    if (code >= 90 && code <= 97) {
      style.foreground = ANSI_16_COLORS[8 + code - 90]
      continue
    }

    if (code >= 100 && code <= 107) {
      style.background = ANSI_16_COLORS[8 + code - 100]
      continue
    }

    if (code === 38 || code === 48) {
      const extended = readAnsiExtendedColor(codes, index)

      if (extended.color) {
        if (code === 38) {
          style.foreground = extended.color
        } else {
          style.background = extended.color
        }
      }

      index = extended.nextIndex
    }
  }
}

function findNextAnsiSequenceIndex(text: string, start: number) {
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index)

    if (code === 0x1b || code === 0x9b) {
      return index
    }
  }

  return -1
}

export function parseAnsiText(text: string): Array<AnsiTextSegment> {
  const segments: Array<AnsiTextSegment> = []
  const style = defaultAnsiStyle()
  let index = 0

  while (index < text.length) {
    const escIndex = findNextAnsiSequenceIndex(text, index)

    if (escIndex < 0) {
      pushAnsiTextSegment(segments, text.slice(index), style)
      break
    }

    pushAnsiTextSegment(segments, text.slice(index, escIndex), style)

    const sequence = parseAnsiSequence(text, escIndex)

    if (!sequence) {
      index = escIndex + 1
      continue
    }

    if (sequence.kind === "sgr") {
      applyAnsiSgrCodes(style, parseAnsiSgrParams(sequence.params))
    }

    index = sequence.end
  }

  return segments
}

export function ansiSegmentStyle(
  style?: AnsiStyleState
): React.CSSProperties | undefined {
  if (!style) return undefined

  return {
    color: style.foreground,
    backgroundColor: style.background,
    fontWeight: style.bold ? 700 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    opacity: style.dim ? 0.72 : undefined,
    textDecorationLine: style.underline ? "underline" : undefined,
  }
}
