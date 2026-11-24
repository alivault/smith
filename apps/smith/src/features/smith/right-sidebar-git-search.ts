import type { GitCommitSearchMode } from "@/lib/smith/api"

export const GIT_COMMIT_SEARCH_MODES: Array<{
  value: GitCommitSearchMode
  label: string
  placeholder: string
}> = [
  { value: "message", label: "Message", placeholder: "Search messages" },
  { value: "code", label: "Code", placeholder: "Search code changes" },
  { value: "author", label: "Author", placeholder: "Search authors" },
  { value: "file", label: "File", placeholder: "Search a file’s history" },
]

export const GIT_COMMIT_SEARCH_MAX_LENGTH = 200
export const GIT_COMMIT_SEARCH_DEBOUNCE_MS = 250

export function isGitCommitSearchMode(
  value: unknown
): value is GitCommitSearchMode {
  return GIT_COMMIT_SEARCH_MODES.some((mode) => mode.value === value)
}

/**
 * The ranges of `text` that contain `query`, ignoring case, in order and
 * without overlap. Each range is `[start, end)`.
 */
export function gitSearchHighlightRanges(
  text: string,
  query: string
): Array<[number, number]> {
  const needle = query.trim().toLowerCase()
  if (!needle || !text) return []
  const haystack = text.toLowerCase()
  // Lowercase can change the length of some characters (for example "İ").
  // Then the indexes do not fit the text, so show no highlight.
  if (haystack.length !== text.length) return []
  const ranges: Array<[number, number]> = []
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    ranges.push([index, index + needle.length])
    index = haystack.indexOf(needle, index + needle.length)
  }
  return ranges
}

/** `text` cut into parts, with `match` true for the parts that match. */
export function gitSearchHighlightParts(text: string, query: string) {
  const parts: Array<{ text: string; match: boolean }> = []
  let last = 0
  for (const [start, end] of gitSearchHighlightRanges(text, query)) {
    if (start > last)
      parts.push({ text: text.slice(last, start), match: false })
    parts.push({ text: text.slice(start, end), match: true })
    last = end
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false })
  return parts
}

const FIELD_SEPARATOR = "\u001f"

/**
 * Search results skip commits, so their real parents are mostly not in the
 * list, and the graph would start a new lane for each row. This makes each
 * row's parent the next row, so the graph is one straight line.
 */
export function linearizeGitCommitLines(lines: Array<string>) {
  const fullHashes = lines.map((line) => {
    const tab = line.indexOf("\t")
    return tab < 0 ? "" : (line.slice(tab + 1).split(FIELD_SEPARATOR)[0] ?? "")
  })
  return lines.map((line, index) => {
    const tab = line.indexOf("\t")
    if (tab < 0) return line
    const fields = line.slice(tab + 1).split(FIELD_SEPARATOR)
    if (fields.length < 5) return line
    fields[1] = fullHashes[index + 1] ?? ""
    return `${line.slice(0, tab + 1)}${fields.join(FIELD_SEPARATOR)}`
  })
}
