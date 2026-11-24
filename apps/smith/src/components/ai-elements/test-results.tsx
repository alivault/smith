import { CircleCheckIcon, CircleXIcon, FlaskConicalIcon } from "lucide-react"

import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace"
import type { TestSummary } from "@/lib/smith/tool-output-detect"

/** "5 passed, 1 failed, 2 skipped". */
function testCountsText(summary: TestSummary) {
  return [
    `${summary.passed} passed`,
    summary.failed ? `${summary.failed} failed` : "",
    summary.skipped ? `${summary.skipped} skipped` : "",
  ]
    .filter(Boolean)
    .join(", ")
}

/**
 * Test Results, the AI Elements pattern
 * (https://ui.shadcn.com/docs/ai-elements/base/test-results): the summary
 * of a test run as a Trace line, open to the tests that failed.
 */
function TestResults({ summary }: { summary: TestSummary }) {
  const failed = summary.failed > 0
  const line = (
    <TraceLine status={failed ? "error" : undefined}>
      <TraceIcon>
        {failed ? (
          <CircleXIcon className="text-destructive" />
        ) : (
          <CircleCheckIcon className="text-success" />
        )}
      </TraceIcon>
      <TraceTitle className="font-medium">
        Ran {summary.total} {summary.total === 1 ? "test" : "tests"}:{" "}
        {testCountsText(summary)}
      </TraceTitle>
    </TraceLine>
  )

  if (summary.failures.length === 0)
    return (
      <Trace data-slot="test-results" className="mb-2">
        {line}
      </Trace>
    )

  return (
    <TraceCollapsible data-slot="test-results" defaultOpen className="mb-2">
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent rail>
        <Trace className="gap-1.5">
          {summary.failures.map((failure, index) => (
            <div key={`${failure.name}:${index}`} className="min-w-0">
              <TraceLine status="error">
                <TraceIcon>
                  <FlaskConicalIcon />
                </TraceIcon>
                <TraceTitle>{failure.name}</TraceTitle>
              </TraceLine>
              {failure.message ? (
                <div className="mt-0.5 ml-5 font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
                  {failure.message}
                </div>
              ) : null}
            </div>
          ))}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

/** The counts of a test run for a tool line, in color. */
function TestResultsCounts({
  summary,
}: {
  summary: Pick<TestSummary, "passed" | "failed">
}) {
  return (
    <span
      className="flex shrink-0 items-center gap-2 text-sm"
      aria-label={`${summary.passed} tests passed, ${summary.failed} failed`}
    >
      <span className="text-success">{summary.passed} passed</span>
      {summary.failed ? (
        <span className="text-destructive">{summary.failed} failed</span>
      ) : null}
    </span>
  )
}

export { TestResults, TestResultsCounts }
