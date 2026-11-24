import { GlobeIcon } from "lucide-react"

import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceSummary,
  TraceTitle,
} from "@/components/ui/trace"
import type { WebSource } from "@/lib/smith/tool-output-detect"

function hostName(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/**
 * Sources, the AI Elements pattern
 * (https://ui.shadcn.com/docs/ai-elements/base/sources): "Used 3 sources",
 * open to a link for each source.
 */
function Sources({ sources }: { sources: Array<WebSource> }) {
  return (
    <TraceCollapsible data-slot="sources" defaultOpen className="mb-2">
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceTitle className="font-medium">
            Used {sources.length} {sources.length === 1 ? "source" : "sources"}
          </TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent rail>
        <Trace className="gap-1.5">
          {sources.map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              title={source.url}
              className="w-fit max-w-full rounded-sm outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&:hover_[data-slot=trace-line]]:text-foreground"
            >
              <TraceLine>
                <TraceIcon>
                  <GlobeIcon />
                </TraceIcon>
                <TraceTitle className="text-foreground">
                  {source.title}
                </TraceTitle>
                <TraceSummary>{hostName(source.url)}</TraceSummary>
                <span className="sr-only">(opens in a new tab)</span>
              </TraceLine>
            </a>
          ))}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

export { Sources }
