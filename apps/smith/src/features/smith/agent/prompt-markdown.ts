/**
 * A system prompt as Markdown for the formatted view. The prompt marks its
 * parts with XML-like tags (`<project_context>`, `<name>…</name>`). The
 * Markdown renderer reads raw HTML, so it would hide these tags. Here they
 * become inline code, so they stay visible. Fenced code blocks and text that
 * is already in backticks stay as they are.
 */
const TAG = /`[^`\n]*`|<\/?[A-Za-z_][\w:.-]*(?:\s[^<>\n]*)?\/?>/g

export function promptMarkdown(text: string) {
  let fence: string | null = null
  return text
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
      if (marker) {
        if (fence === null) fence = marker
        else if (marker.startsWith(fence)) fence = null
        return line
      }
      if (fence !== null) return line
      return line.replace(TAG, (match) =>
        match.startsWith("`") ? match : `\`${match}\``
      )
    })
    .join("\n")
}
