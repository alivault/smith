import * as React from "react"
import { TriangleAlertIcon } from "lucide-react"

import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace"
import type { StackFrame, StackTraceInfo } from "@/lib/smith/tool-output-detect"
import { cn } from "@/lib/utils"

/**
 * Stack Trace, the AI Elements pattern
 * (https://ui.shadcn.com/docs/ai-elements/base/stack-trace): the error as a
 * red Trace line, open to its frames. Frames of Node and of dependencies
 * are dimmed. `renderFile` can turn the file of a frame into a link.
 */
function StackTrace({
  renderFile,
  trace,
}: {
  renderFile?: (frame: StackFrame) => React.ReactNode
  trace: StackTraceInfo
}) {
  return (
    <TraceCollapsible data-slot="stack-trace" defaultOpen className="mb-2">
      <TraceCollapsibleTrigger>
        <TraceLine status="error">
          <TraceIcon>
            <TriangleAlertIcon className="text-destructive" />
          </TraceIcon>
          <TraceTitle className="font-medium">
            {trace.type}: {trace.message}
          </TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <ol className="space-y-0.5 rounded-lg bg-muted/50 p-2.5 font-mono text-xs">
          {trace.frames.map((frame, index) => (
            <li
              key={index}
              className={cn(
                "min-w-0 truncate",
                frame.internal ? "text-muted-foreground/60" : "text-foreground"
              )}
            >
              <span className="text-muted-foreground">at </span>
              {frame.fn ? <span>{frame.fn} </span> : null}
              {frame.file ? (
                <span className="text-muted-foreground">
                  {!frame.internal && renderFile ? (
                    renderFile(frame)
                  ) : (
                    <>
                      {frame.file}
                      {frame.line ? `:${frame.line}` : ""}
                      {frame.column ? `:${frame.column}` : ""}
                    </>
                  )}
                </span>
              ) : (
                frame.raw
              )}
            </li>
          ))}
        </ol>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

export { StackTrace }
