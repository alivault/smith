import * as React from "react"
import { Progress as ProgressPrimitive } from "@base-ui/react/progress"

import { ProgressIndicator, ProgressTrack } from "@/components/ui/progress"
import { cn } from "@/lib/utils"

/**
 * The usage bar of Context, the AI Elements pattern
 * (https://ui.shadcn.com/docs/ai-elements/base/context): a Progress that
 * shows how much of the context window (or of a rate limit window) is used.
 * Smith colors the bar by how full it is, and marks points on it, as the
 * compaction point.
 */
function ContextBar({
  className,
  color,
  marks = [],
  value,
  ...props
}: Omit<React.ComponentProps<typeof ProgressPrimitive.Root>, "value"> & {
  /** The color of the used part. */
  color?: string
  /** Positions, in percent, to mark on the bar. */
  marks?: Array<number | null | undefined>
  /** The used part in percent, or null when it is not known. */
  value: number | null
}) {
  const clamped = value == null ? null : Math.max(0, Math.min(100, value))
  return (
    <ProgressPrimitive.Root
      data-slot="context-bar"
      value={clamped}
      className={cn("block", className)}
      {...props}
    >
      {/* The track uses the text color, so it shows also on a hovered menu
          item. */}
      <ProgressTrack className="h-1 bg-foreground/15">
        {clamped == null ? null : (
          <ProgressIndicator
            className="transition-none"
            style={{ backgroundColor: color }}
          />
        )}
        {marks.map((mark, index) =>
          mark == null ? null : (
            <span
              key={index}
              aria-hidden="true"
              className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground/60"
              style={{ left: `${Math.max(0, Math.min(100, mark))}%` }}
            />
          )
        )}
      </ProgressTrack>
    </ProgressPrimitive.Root>
  )
}

export { ContextBar }
