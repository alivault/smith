import * as React from "react"
import { CheckIcon, CopyIcon, ServerOffIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { TitleTooltip } from "@/components/ui/tooltip"
import { copyTextToClipboard } from "@/lib/clipboard"
import {
  isServerLost,
  useServerConnection,
  type ServerConnectionState,
} from "@/lib/smith/server-connection"
import { cn } from "@/lib/utils"

/** The command that starts Smith (`bin/smith.mjs`; `serve` is its default). */
const START_COMMAND = "smith"
/** How long "Connected" shows before it fades. */
const CONNECTED_MS = 1000
const FADE_MS = 300

type Shown = Exclude<ServerConnectionState, "unknown" | "online"> | "connected"

/**
 * The status of the Smith server while it does not answer (see
 * `lib/smith/server-connection.ts`): a small pill at the top of the page.
 * The page stays usable below it; only server actions wait. After
 * `DOWN_AFTER_MS` the pill grows into a card that tells how to start Smith.
 * When the server answers again, it shows "Connected" for a moment.
 */
export function ServerConnectionPill() {
  const state = useServerConnection()
  const shown = useShownState(state)
  if (!shown.value) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed inset-x-0 z-50 flex justify-center px-4 transition-opacity duration-300 ease-out motion-reduce:transition-none",
        // The pill sits in the header row; the larger card goes below the
        // header, so that it does not cover the agent's title.
        shown.value === "down"
          ? "top-[calc(var(--header-height,3rem)+0.75rem)]"
          : "top-[calc(env(safe-area-inset-top)+0.375rem)]",
        shown.leaving ? "opacity-0" : "opacity-100"
      )}
    >
      {shown.value === "down" ? (
        <ServerDownCard />
      ) : (
        <div className="pointer-events-auto flex h-9 animate-in items-center gap-2 rounded-full border bg-popover/95 px-4 text-sm font-medium text-popover-foreground shadow-lg backdrop-blur-md duration-200 fade-in-0 slide-in-from-top-2 motion-reduce:animate-none">
          {shown.value === "connected" ? (
            <CheckIcon aria-hidden className="size-4 text-success" />
          ) : (
            <Spinner aria-hidden size="md" />
          )}
          {PILL_TEXT[shown.value]}
        </div>
      )}
    </div>
  )
}

const PILL_TEXT = {
  restarting: "Restarting Smith…",
  reconnecting: "Reconnecting to Smith…",
  connected: "Connected",
} as const satisfies Record<Exclude<Shown, "down">, string>

/** What the pill shows: the lost state, then "Connected" for a moment. */
function useShownState(state: ServerConnectionState) {
  const [shown, setShown] = React.useState<{
    value: Shown | undefined
    leaving: boolean
  }>({ value: undefined, leaving: false })
  const lost = isServerLost(state)
  const [previousState, setPreviousState] = React.useState(state)
  if (previousState !== state) {
    setPreviousState(state)
    if (lost) setShown({ value: state, leaving: false })
    else if (state === "online" && isServerLost(previousState))
      setShown({ value: "connected", leaving: false })
  }

  React.useEffect(() => {
    if (shown.value !== "connected") return
    if (!shown.leaving) {
      const timer = setTimeout(
        () => setShown({ value: "connected", leaving: true }),
        CONNECTED_MS
      )
      return () => clearTimeout(timer)
    }
    const timer = setTimeout(
      () => setShown({ value: undefined, leaving: false }),
      FADE_MS
    )
    return () => clearTimeout(timer)
  }, [shown])

  return shown
}

function ServerDownCard() {
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div className="pointer-events-auto flex w-full max-w-sm animate-in flex-col gap-3 rounded-2xl border bg-popover/95 p-4 text-sm text-popover-foreground shadow-lg backdrop-blur-md duration-200 fade-in-0 zoom-in-95 motion-reduce:animate-none">
      <div className="flex items-start gap-3">
        <ServerOffIcon
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium">Smith’s server is not running</p>
          <p className="text-muted-foreground">
            Start it in a terminal. This page continues when the server answers.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1 rounded-lg bg-muted py-1 pr-1 pl-3 font-mono text-[0.8rem]">
        <span className="min-w-0 flex-1 truncate select-all">
          {START_COMMAND}
        </span>
        <TitleTooltip title={copied ? "Copied" : "Copy"}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Copy ${START_COMMAND}`}
            onClick={() => {
              void copyTextToClipboard(START_COMMAND).then(
                () => setCopied(true),
                () => undefined
              )
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </TitleTooltip>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-muted-foreground">
          <Spinner aria-hidden />
          Trying to connect…
        </span>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Reload page
        </Button>
      </div>
    </div>
  )
}
