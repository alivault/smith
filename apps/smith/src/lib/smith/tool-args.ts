export function normalizeToolArgs(args: unknown) {
  if (!args) return undefined
  if (typeof args === "object") {
    return args as Record<string, unknown>
  }
  if (typeof args !== "string") return undefined

  try {
    const parsed = JSON.parse(args)
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export function getToolArgText(
  args: Record<string, unknown> | undefined,
  key: string
) {
  const value = args?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : ""
}

function looksLikeJsonObjectPrefix(text: string) {
  return text === "{" || /^\{\s*(?:"|$)/.test(text)
}

function toolArgsAreIncompleteJsonObject(args: unknown) {
  if (typeof args !== "string") return false

  const trimmed = args.trim()
  if (!looksLikeJsonObjectPrefix(trimmed)) return false

  try {
    JSON.parse(trimmed)
    return false
  } catch {
    return true
  }
}

function readPartialJsonStringValue(text: string, start: number) {
  let value = ""
  let escaped = false

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]

    if (escaped) {
      switch (char) {
        case '"':
        case "\\":
        case "/":
          value += char
          break
        case "b":
          value += "\b"
          break
        case "f":
          value += "\f"
          break
        case "n":
          value += "\n"
          break
        case "r":
          value += "\r"
          break
        case "t":
          value += "\t"
          break
        case "u": {
          const hex = text.slice(index + 1, index + 5)
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            value += String.fromCharCode(Number.parseInt(hex, 16))
            index += 4
          } else {
            value += char
          }
          break
        }
        default:
          value += char || ""
          break
      }
      escaped = false
      continue
    }

    if (char === "\\") {
      escaped = true
      continue
    }

    if (char === '"') break

    value += char || ""
  }

  return value.trim()
}

function partialJsonStringProperty(text: string, property: string) {
  const propertyPattern = new RegExp(
    `"${property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*"`,
    "g"
  )
  const match = propertyPattern.exec(text)
  if (!match) return ""

  return readPartialJsonStringValue(text, match.index + match[0].length)
}

export function rawShellCommandTextFromTool(
  name: string | undefined,
  args: unknown
) {
  if (name !== "bash") return ""

  if (typeof args === "string") {
    const trimmed = args.trim()
    if (!trimmed) return ""

    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === "object" && "command" in parsed) {
        const command = (parsed as Record<string, unknown>).command
        return typeof command === "string" ? command.trim() : ""
      }
    } catch {
      if (toolArgsAreIncompleteJsonObject(trimmed)) {
        return partialJsonStringProperty(trimmed, "command")
      }

      return trimmed
    }

    return trimmed
  }

  const normalizedArgs = normalizeToolArgs(args)
  return getToolArgText(normalizedArgs, "command")
}

export function getToolArgNumber(
  args: Record<string, unknown> | undefined,
  key: string
) {
  const value = args?.[key]
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN

  return Number.isFinite(numberValue) ? numberValue : undefined
}

function formatToolArg(key: string, value: string | number | undefined) {
  if (value === undefined || value === "") return ""
  return `${key}=${value}`
}

/**
 * The one-line summary of a search, a file list, or a shell call: what it
 * looks for and where. Empty for other tools and for calls that have no
 * arguments yet.
 */
export function searchToolSummary(name: string | undefined, args: unknown) {
  const parsed = normalizeToolArgs(args)
  const text = (key: string) => getToolArgText(parsed, key)
  const path = text("path")
  let parts: Array<string>

  switch (name) {
    case "bash":
      return (text("description") || rawShellCommandTextFromTool(name, args))
        .replace(/\s+/g, " ")
        .trim()
    case "grep":
    case "rg":
    case "glob":
    case "find": {
      const pattern =
        text("pattern") ||
        text("query") ||
        (name === "find" ? text("name") : "")
      if (!pattern && !path) return ""
      parts = [
        pattern && path ? `${pattern} in ${path}` : pattern || path,
        formatToolArg("glob", text("glob")),
        formatToolArg("include", text("include")),
        formatToolArg("limit", getToolArgNumber(parsed, "limit")),
      ]
      break
    }
    case "ls":
    case "list":
      if (!parsed) return ""
      parts = [
        path || ".",
        formatToolArg("limit", getToolArgNumber(parsed, "limit")),
      ]
      break
    default:
      return ""
  }

  return parts.filter(Boolean).join(" · ").replace(/\s+/g, " ").trim()
}
