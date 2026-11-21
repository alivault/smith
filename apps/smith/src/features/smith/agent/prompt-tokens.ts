/** Token counts of the system prompt, from `/api/agent/system-prompt`. */
export type TokenCount = { tokens: number; exact: boolean }

export type PromptTokens = {
  method: "exact" | "estimate"
  pending: boolean
  note?: string
  model?: { provider: string; id: string; contextWindow?: number }
  /** Cache read price as a fraction of the input price. */
  cacheRead?: number
  parts: Record<string, TokenCount>
  prompt: TokenCount
  tools: {
    total: TokenCount
    overhead?: TokenCount
    items: Array<{ name: string } & TokenCount>
  }
  total: TokenCount
}

/** A short token count: `840`, `1.2k`, `12k`, `1.2M`; `~` for an estimate. */
export function formatTokens(count: TokenCount) {
  const { tokens } = count
  const prefix = count.exact ? "" : "~"
  if (tokens < 1000) return `${prefix}${tokens}`
  if (tokens < 1_000_000) {
    const value = tokens / 1000
    return `${prefix}${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)}k`
  }
  const value = tokens / 1_000_000
  return `${prefix}${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)}M`
}

/** The part of the context window, as `2%` or `<1%`. */
export function contextShare(
  tokens: number,
  contextWindow: number | undefined
) {
  if (!contextWindow || contextWindow <= 0) return undefined
  const percent = (tokens / contextWindow) * 100
  if (percent < 1) return "<1%"
  return `${Math.round(percent)}%`
}

/** How the counts were made, in a short clause. */
export function methodLabel(tokens: PromptTokens) {
  if (tokens.total.exact) return "Exact counts from Anthropic"
  if (tokens.method === "exact" && tokens.pending)
    return "Estimates (~) until Anthropic counts them"
  const note = tokens.note
  return note
    ? `Estimates (~): ${note.charAt(0).toLowerCase()}${note.slice(1)}`
    : "Estimates (~)"
}

/** The cache read price as a share of the input price: `about 10%`. */
export function cacheShare(tokens: PromptTokens) {
  const ratio = tokens.cacheRead
  if (ratio === undefined || !(ratio > 0) || ratio >= 1) return undefined
  const percent = ratio * 100
  return percent < 1
    ? "less than 1%"
    : `about ${percent < 10 ? Math.round(percent * 10) / 10 : Math.round(percent)}%`
}

/** The note under the system prompt group: only when the counts are estimates. */
export function estimateNote(tokens: PromptTokens | undefined) {
  if (!tokens || tokens.total.exact) return undefined
  return `${methodLabel(tokens)}.`
}

/** The tooltip of the section header: context share, then the cache price. */
export function summaryLines(tokens: PromptTokens) {
  const lines: string[] = []
  const window = tokens.model?.contextWindow
  const share = contextShare(tokens.total.tokens, window)
  if (share && window)
    lines.push(
      `System prompt ${formatTokens(tokens.prompt)} and tools ${formatTokens(tokens.tools.total)}: ${share} of the ${formatTokens({ tokens: window, exact: true })} context window.`
    )
  const cache = cacheShare(tokens)
  if (cache)
    lines.push(`Cached after the first request: ${cache} of the input price.`)
  return lines
}

/**
 * The widths of a stacked share bar, in percent, for these values. Each
 * part that is not empty gets at least `min` percent, so it stays
 * visible; the larger parts give up the space. Empty parts get 0.
 */
export function shareWidths(values: readonly number[], min = 2) {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0)
  if (total <= 0) return values.map(() => 0)
  const raw = values.map((value) => (Math.max(0, value) / total) * 100)
  const visible = raw.filter((width) => width > 0).length
  // With too many parts for the minimum, share the bar equally.
  if (visible * min >= 100)
    return raw.map((width) => (width > 0 ? 100 / visible : 0))
  // Raise the small parts to the minimum, and scale the others down. Do it
  // again while scaling pushes a part under the minimum.
  const small = new Set<number>()
  for (;;) {
    const fixed = small.size * min
    const rest = raw.reduce(
      (sum, width, index) =>
        width > 0 && !small.has(index) ? sum + width : sum,
      0
    )
    const scale = (100 - fixed) / rest
    const next = raw.findIndex(
      (width, index) => width > 0 && !small.has(index) && width * scale < min
    )
    if (next === -1)
      return raw.map((width, index) =>
        width <= 0 ? 0 : small.has(index) ? min : width * scale
      )
    small.add(next)
  }
}

/**
 * Colors of the parts in the share bar and the dots of their rows. They are
 * mid tones, so they show on light and dark backgrounds. The parts use them
 * in turn; the tools always get the neutral color.
 */
export const PART_COLORS = [
  "bg-blue-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-pink-500",
  "bg-cyan-500",
  "bg-lime-500",
] as const

export const TOOLS_COLOR = "bg-zinc-400 dark:bg-zinc-500"

export function partColor(index: number) {
  return PART_COLORS[index % PART_COLORS.length]
}

/**
 * The tools by size, largest first, each with its color: as in Storage, only
 * the largest few get a color; the rest share the neutral one.
 */
export function rankTools<T extends { name: string; tokens: number }>(
  items: readonly T[],
  colored = 5
) {
  return [...items]
    .sort(
      (left, right) =>
        right.tokens - left.tokens || left.name.localeCompare(right.name)
    )
    .map((item, index) => ({
      ...item,
      color: index < colored ? partColor(index) : TOOLS_COLOR,
    }))
}
