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

/** How the counts were made, in one short sentence. */
export function methodLabel(tokens: PromptTokens) {
  if (tokens.total.exact) return "Exact counts from Anthropic."
  if (tokens.method === "exact" && tokens.pending)
    return "Estimates (~) until the exact counts from Anthropic come."
  return `Estimates (~): about 3.5 characters a token.${tokens.note ? ` ${tokens.note}.` : ""}`
}

/** One line about prompt caching, from the model's prices. */
export function cacheNote(tokens: PromptTokens) {
  const ratio = tokens.cacheRead
  if (ratio === undefined || !(ratio > 0) || ratio >= 1) return undefined
  const percent = ratio * 100
  const share =
    percent < 1
      ? "less than 1%"
      : `about ${percent < 10 ? Math.round(percent * 10) / 10 : Math.round(percent)}%`
  return `Cached after the first request: later requests pay ${share} of the input price for it.`
}
