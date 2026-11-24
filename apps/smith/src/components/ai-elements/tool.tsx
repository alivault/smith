import * as React from "react"

import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceLine,
  TraceSummary,
  TraceTitle,
} from "@/components/ui/trace"
import { cn } from "@/lib/utils"

/**
 * Tool, the AI Elements pattern
 * (https://ui.shadcn.com/docs/ai-elements/base/tool): a tool call as one
 * Trace line that opens to show its input and output. The line names the
 * tool and summarizes the call; the title shimmers while the tool runs and
 * turns red when it fails.
 */
function Tool({
  className,
  ...props
}: React.ComponentProps<typeof TraceCollapsible>) {
  return (
    <TraceCollapsible
      data-conversation-row="true"
      className={className}
      {...props}
    />
  )
}

function ToolHeader({
  children,
  isError = false,
  label,
  running = false,
  summary,
  summaryClassName,
}: {
  /** Trailing facts, as the line counts of an edit. */
  children?: React.ReactNode
  isError?: boolean
  label: React.ReactNode
  running?: boolean
  summary?: React.ReactNode
  summaryClassName?: string
}) {
  return (
    <TraceCollapsibleTrigger data-conversation-tool-collapsible-trigger="true">
      <TraceLine status={running ? "running" : isError ? "error" : undefined}>
        <TraceTitle className="shrink-0 overflow-visible font-medium whitespace-nowrap">
          {label}
        </TraceTitle>
        {summary ? (
          <TraceSummary className={summaryClassName}>{summary}</TraceSummary>
        ) : null}
        {children ? <TraceDescription>{children}</TraceDescription> : null}
      </TraceLine>
    </TraceCollapsibleTrigger>
  )
}

function ToolContent({
  className,
  ...props
}: React.ComponentProps<typeof TraceCollapsibleContent>) {
  return <TraceCollapsibleContent className={cn(className)} {...props} />
}

export { Tool, ToolHeader, ToolContent }
