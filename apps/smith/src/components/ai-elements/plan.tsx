import * as React from "react"

import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import { cn } from "@/lib/utils"

/**
 * Plan, the AI Elements pattern
 * (https://ui.shadcn.com/docs/ai-elements/base/plan): the steps the agent
 * plans to take, each a Trace line with its state.
 */
function Plan({ className, ...props }: React.ComponentProps<typeof Trace>) {
  return (
    <Trace
      role="list"
      data-slot="plan"
      className={cn("gap-1.5", className)}
      {...props}
    />
  )
}

function PlanStep({
  done = false,
  active = false,
  icon,
  label,
  note,
  title,
}: {
  active?: boolean
  done?: boolean
  icon: React.ReactNode
  /** The state, for screen readers. */
  label: string
  note?: string
  title: string
}) {
  return (
    <TraceLine
      role="listitem"
      className="w-full items-start gap-1.5 text-foreground"
    >
      <TraceIcon
        role="img"
        aria-hidden={false}
        aria-label={label}
        className="mt-0.5 size-4 [&_svg:not([class*='size-'])]:size-4"
      >
        {icon}
      </TraceIcon>
      <span className="min-w-0 flex-1">
        <TraceTitle
          className={cn(
            "block whitespace-normal",
            done && "text-muted-foreground line-through",
            active && "font-medium"
          )}
        >
          {title}
        </TraceTitle>
        {note ? (
          <span className="block text-xs text-muted-foreground">{note}</span>
        ) : null}
      </span>
    </TraceLine>
  )
}

export { Plan, PlanStep }
