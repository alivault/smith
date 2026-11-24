import * as React from "react"
import { ChevronRightIcon } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

/**
 * Trace, from shadcn/ui (https://ui.shadcn.com/docs/components/base/trace):
 * one line for each step of the agent's work (thinking, a tool call, a
 * source), which can open to show more. Restyled for Smith: the chevron
 * leads the line, as in the Finder's outline view, and the open content
 * sits under the line without a rail unless it asks for one.
 */
function Trace({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="trace"
      className={cn("flex w-full min-w-0 flex-col gap-2", className)}
      {...props}
    />
  )
}

/**
 * One line. `running` shimmers the title, `error` colors it red, and
 * `pending` dims the line. Wrap it in a trigger to make it do something.
 */
function TraceLine({
  className,
  status,
  ...props
}: React.ComponentProps<"span"> & {
  status?: "running" | "error" | "pending"
}) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cn(
        "flex w-fit max-w-full min-w-0 items-center gap-1 text-sm text-muted-foreground",
        "data-[status=pending]:opacity-60",
        "data-[status=running]:*:data-[slot=trace-title]:shimmer data-[status=running]:*:data-[slot=trace-title]:text-amber-600 dark:data-[status=running]:*:data-[slot=trace-title]:text-amber-400",
        "data-[status=error]:*:data-[slot=trace-title]:text-destructive",
        className
      )}
      {...props}
    />
  )
}

function TraceIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5",
        className
      )}
      {...props}
    />
  )
}

/** What the step is, as "Bash" or "Thinking". It shimmers while it runs. */
function TraceTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-title"
      className={cn(
        "min-w-0 truncate motion-reduce:shimmer-none [[data-slot=trace-icon]+&]:ml-0.5",
        className
      )}
      {...props}
    />
  )
}

/** The detail after the title, as a command or a path. It truncates. */
function TraceSummary({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-summary"
      className={cn("ml-0.5 min-w-0 truncate", className)}
      {...props}
    />
  )
}

/** A short trailing fact, as "+3 −2" or "4s". It does not shrink. */
function TraceDescription({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-description"
      className={cn("ml-1 shrink-0 tabular-nums", className)}
      {...props}
    />
  )
}

function TraceCollapsible({
  className,
  ...props
}: React.ComponentProps<typeof Collapsible>) {
  return (
    <Collapsible
      data-slot="trace-collapsible"
      className={cn("flex w-full min-w-0 flex-col text-sm", className)}
      {...props}
    />
  )
}

function TraceCollapsibleTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger
      data-slot="trace-collapsible-trigger"
      className={cn(
        "group/trace-collapsible-trigger -ml-0.5 flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-sm text-left text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        className
      )}
      {...props}
    >
      <TraceIcon className="transition-transform group-aria-expanded/trace-collapsible-trigger:rotate-90">
        <ChevronRightIcon />
      </TraceIcon>
      {children}
    </CollapsibleTrigger>
  )
}

/**
 * The detail of an open line. `rail` draws a line on its left, for steps
 * and text that belong to the line above (a summary that opens into its
 * steps, or thinking).
 */
function TraceCollapsibleContent({
  className,
  innerClassName,
  children,
  rail = false,
  ...props
}: React.ComponentProps<typeof CollapsibleContent> & {
  innerClassName?: string
  rail?: boolean
}) {
  return (
    <CollapsibleContent
      data-slot="trace-collapsible-content"
      className={cn(
        "h-(--collapsible-panel-height) min-w-0 overflow-hidden text-sm transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none",
        className
      )}
      {...props}
    >
      <div
        data-slot="trace-collapsible-content-inner"
        data-rail={rail || undefined}
        className={cn(
          "min-w-0 pt-2",
          rail && "mt-2 ml-1.5 border-l-2 pt-0 pl-4",
          innerClassName
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  )
}

export {
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceSummary,
  TraceDescription,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
}
