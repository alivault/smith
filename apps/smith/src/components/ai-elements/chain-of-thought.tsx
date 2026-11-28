import * as React from "react"

import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceLine,
  TraceSummary,
  TraceTitle,
} from "@/components/ui/trace"
import { traceStatus } from "@/components/ai-elements/status-icon"
import { cn } from "@/lib/utils"

/**
 * Chain of Thought, the AI Elements pattern
 * (https://ui.shadcn.com/docs/ai-elements/base/chain-of-thought): a summary
 * line, as "Worked for 4m 3s" or "Explore 2 reads", that opens into the
 * steps behind it.
 */
function ChainOfThought(props: React.ComponentProps<typeof TraceCollapsible>) {
  return <TraceCollapsible data-conversation-row="true" {...props} />
}

function ChainOfThoughtHeader({
  isError = false,
  label,
  running = false,
  summary,
}: {
  isError?: boolean
  label: React.ReactNode
  running?: boolean
  summary?: React.ReactNode
}) {
  return (
    <TraceCollapsibleTrigger data-conversation-tool-collapsible-trigger="true">
      <TraceLine status={traceStatus(running, isError)}>
        <TraceTitle
          className={cn(summary && "shrink-0 overflow-visible font-medium")}
        >
          {label}
        </TraceTitle>
        {summary ? <TraceSummary>{summary}</TraceSummary> : null}
      </TraceLine>
    </TraceCollapsibleTrigger>
  )
}

function ChainOfThoughtContent(
  props: React.ComponentProps<typeof TraceCollapsibleContent>
) {
  return <TraceCollapsibleContent {...props} />
}

/** The steps of an open chain, on the rail of the content. */
function ChainOfThoughtSteps({
  className,
  ...props
}: React.ComponentProps<typeof Trace>) {
  return <Trace className={className} {...props} />
}

/** One step: what it did, and on what. */
function ChainOfThoughtStep({
  description,
  isError = false,
  label,
  running = false,
}: {
  description: React.ReactNode
  isError?: boolean
  label: React.ReactNode
  running?: boolean
}) {
  return (
    <TraceLine status={traceStatus(running, isError)} className="max-w-full">
      <TraceTitle className="shrink-0 overflow-visible font-medium text-foreground">
        {label}
      </TraceTitle>
      <span className="no-scrollbar min-w-0 overflow-x-auto whitespace-nowrap">
        {description}
      </span>
    </TraceLine>
  )
}

export {
  ChainOfThought,
  ChainOfThoughtHeader,
  ChainOfThoughtContent,
  ChainOfThoughtSteps,
  ChainOfThoughtStep,
}
