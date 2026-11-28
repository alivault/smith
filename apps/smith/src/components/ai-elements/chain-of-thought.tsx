import * as React from "react"

import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace"

/**
 * Chain of Thought, the AI Elements pattern
 * (https://ui.shadcn.com/docs/ai-elements/base/chain-of-thought): a summary
 * line, as "Worked for 4m 3s", that opens into the steps behind it.
 */
function ChainOfThought(props: React.ComponentProps<typeof TraceCollapsible>) {
  return <TraceCollapsible data-conversation-row="true" {...props} />
}

function ChainOfThoughtHeader({ label }: { label: React.ReactNode }) {
  return (
    <TraceCollapsibleTrigger data-conversation-tool-collapsible-trigger="true">
      <TraceLine>
        <TraceTitle>{label}</TraceTitle>
      </TraceLine>
    </TraceCollapsibleTrigger>
  )
}

function ChainOfThoughtContent(
  props: React.ComponentProps<typeof TraceCollapsibleContent>
) {
  return <TraceCollapsibleContent {...props} />
}

export { ChainOfThought, ChainOfThoughtHeader, ChainOfThoughtContent }
