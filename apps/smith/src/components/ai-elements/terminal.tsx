import * as React from "react"

import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block"
import { ansiSegmentStyle, parseAnsiText } from "@/lib/ansi"
import { cn } from "@/lib/utils"

/**
 * Terminal, the AI Elements pattern
 * (https://ui.shadcn.com/docs/ai-elements/base/terminal): the command and
 * output of a shell call in a small Code Block, with the ANSI colors of
 * the output. The content scrolls; give `contentRef` and `onScroll` to
 * follow the output while it streams.
 */
function Terminal({
  children,
  className,
  contentRef,
  isError = false,
  onScroll,
}: {
  children: React.ReactNode
  className?: string
  contentRef?: React.Ref<HTMLPreElement>
  isError?: boolean
  onScroll?: React.UIEventHandler<HTMLPreElement>
}) {
  return (
    <CodeBlock
      size="sm"
      variant={isError ? "destructive" : "default"}
      className={className}
    >
      <CodeBlockContent
        wrap
        ref={contentRef}
        onScroll={onScroll}
        className="max-h-96"
      >
        {children}
      </CodeBlockContent>
    </CodeBlock>
  )
}

/** Text with ANSI escape sequences, in its colors. */
function AnsiText({ text, className }: { text: string; className?: string }) {
  const segments = parseAnsiText(text)

  return (
    <code className={cn(className)}>
      {segments.map((segment, index) => (
        <span
          // The segments of one text do not move, so the index is stable.
          key={index}
          style={ansiSegmentStyle(segment.style)}
        >
          {segment.text}
        </span>
      ))}
    </code>
  )
}

export { Terminal, AnsiText }
