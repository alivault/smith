import * as React from "react"

import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace"
import { traceStatus } from "@/components/ai-elements/status-icon"
import { cn } from "@/lib/utils"

/**
 * Reasoning, the AI Elements pattern
 * (https://ui.shadcn.com/docs/ai-elements/base/reasoning): the agent's
 * thinking as a Trace line that opens to show the text. The title
 * shimmers while the thinking streams.
 */
function Reasoning(props: React.ComponentProps<typeof TraceCollapsible>) {
  return <TraceCollapsible data-conversation-row="true" {...props} />
}

function ReasoningTrigger({
  label,
  streaming = false,
}: {
  label: React.ReactNode
  streaming?: boolean
}) {
  return (
    <TraceCollapsibleTrigger data-conversation-tool-collapsible-trigger="true">
      <TraceLine status={traceStatus(streaming, false)}>
        <TraceTitle>{label}</TraceTitle>
      </TraceLine>
    </TraceCollapsibleTrigger>
  )
}

/** The rail of thinking text, open or in a Reasoning line. */
const REASONING_TEXT_CLASS =
  "border-l-2 border-amber-500/45 pl-4 text-sm text-muted-foreground"

function ReasoningContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof TraceCollapsibleContent>) {
  return (
    <TraceCollapsibleContent className={className} {...props}>
      {children}
    </TraceCollapsibleContent>
  )
}

/** Thinking text with its amber rail, for thinking that shows open. */
function ReasoningText({
  className,
  ...props
}: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="reasoning-text"
      className={cn(REASONING_TEXT_CLASS, className)}
      {...props}
    />
  )
}

export { Reasoning, ReasoningTrigger, ReasoningContent, ReasoningText }
