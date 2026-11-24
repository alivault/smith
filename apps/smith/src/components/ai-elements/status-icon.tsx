import {
  CircleAlertIcon,
  CircleCheckIcon,
  LoaderCircleIcon,
} from "lucide-react"

export type TraceStatus = "running" | "error" | undefined

/** The status of a Trace line, from its flags. */
export function traceStatus(running: boolean, isError: boolean): TraceStatus {
  return running ? "running" : isError ? "error" : undefined
}

/**
 * The status icon of a step, as in the Chain of Thought example
 * (https://ui.shadcn.com/docs/ai-elements/base/chain-of-thought): a spinner
 * while it runs, a check when it is done, an alert when it failed. It takes
 * the color of its line. Put it in a `TraceIcon`.
 */
export function StatusIcon({ status }: { status?: TraceStatus }) {
  if (status === "running")
    return (
      <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
    )
  return status === "error" ? <CircleAlertIcon /> : <CircleCheckIcon />
}
