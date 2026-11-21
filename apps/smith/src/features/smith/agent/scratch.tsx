import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { NotebookTextIcon, Trash2Icon } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  registerAgentSection,
  type AgentSectionProps,
} from "@/features/smith/agent/agent-panel"
import {
  agentExtensionsQueryKey,
  type AgentExtensionState,
} from "@/features/smith/agent/agent-extensions"
import {
  clearScratchDescription,
  formatBytes,
  scratchEntriesFrom,
  withoutScratchEntries,
  type ScratchEntry,
} from "@/features/smith/agent/scratch-state"
import {
  errorText,
  IconAction,
  relativeTime,
  TextDialog,
  useNow,
} from "@/features/smith/agent/shared"
import { REVEAL_ON_HOVER } from "@/features/smith/agent/todo"
import { buildRequestUrl, fetchJson } from "@/features/smith/app-shell-utils"
import {
  registerToolRenderer,
  toolArgs,
  toolDetails,
} from "@/features/smith/tool-renderers/registry"
import { useMachineId } from "@/lib/smith/machine-context"
import { toast } from "@/lib/smith/toast"
import { cn } from "@/lib/utils"

/**
 * Deletes one entry (`id`) or all of them, and shows it at once. A failed
 * delete comes back with the next read.
 */
function useScratchDelete(viewerContextId: string, agentId: string) {
  const machineId = useMachineId()
  const queryClient = useQueryClient()
  const queryKey = agentExtensionsQueryKey(viewerContextId, agentId)
  return async (target: { id: string } | "all") => {
    void queryClient.cancelQueries({ queryKey })
    queryClient.setQueryData<AgentExtensionState>(queryKey, (state) =>
      state
        ? withoutScratchEntries(
            state,
            target === "all" ? "all" : new Set([target.id])
          )
        : state
    )
    try {
      await fetchJson(
        buildRequestUrl("/api/agent/scratch", {
          machineId,
          contextId: viewerContextId,
          agentId,
          searchParams: target === "all" ? { all: "1" } : { id: target.id },
        }),
        { method: "DELETE" }
      )
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      void queryClient.invalidateQueries({ queryKey })
    }
  }
}

function ScratchSection({
  agentId,
  state,
  viewerContextId,
}: AgentSectionProps) {
  const entries = scratchEntriesFrom(state)
  const [open, setOpen] = React.useState<ScratchEntry | null>(null)
  const remove = useScratchDelete(viewerContextId, agentId)
  const now = useNow(30_000)
  return (
    <>
      <ul className="space-y-0.5">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="group/row flex h-7 min-w-0 items-center gap-0.5 rounded-md hover:bg-muted/50"
          >
            <button
              type="button"
              aria-label={`Show ${entry.name}`}
              className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-1.5 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={() => setOpen(entry)}
            >
              <NotebookTextIcon
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatBytes(entry.bytes)} ·{" "}
                {relativeTime(entry.createdAt, now).replace(/ ago$/, "")}
              </span>
            </button>
            <IconAction
              label={`Delete ${entry.name}`}
              icon={<Trash2Icon />}
              size="icon-xs"
              tone="destructive"
              className={cn(
                "shrink-0 group-focus-within/row:opacity-100",
                REVEAL_ON_HOVER
              )}
              onClick={() => void remove({ id: entry.id })}
            />
          </li>
        ))}
      </ul>
      {open ? (
        <TextDialog
          open
          onOpenChange={(next) => {
            if (!next) setOpen(null)
          }}
          title={`${open.name} · ${open.lines} ${open.lines === 1 ? "line" : "lines"}`}
          path="/api/agent/scratch"
          searchParams={{ id: open.id }}
          agentId={agentId}
          viewerContextId={viewerContextId}
        />
      ) : null}
    </>
  )
}

function ScratchActions({
  agentId,
  state,
  viewerContextId,
}: AgentSectionProps) {
  const count = scratchEntriesFrom(state).length
  const [confirming, setConfirming] = React.useState(false)
  const remove = useScratchDelete(viewerContextId, agentId)
  if (count === 0) return null
  return (
    <>
      <IconAction
        label="Clear the scratchpad"
        icon={<Trash2Icon />}
        tone="destructive"
        onClick={() => setConfirming(true)}
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the scratchpad?</AlertDialogTitle>
            <AlertDialogDescription>
              {clearScratchDescription(count)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirming(false)
                void remove("all")
              }}
            >
              Clear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

registerAgentSection({
  key: "scratch",
  title: "Scratchpad",
  order: 60,
  defaultOpen: false,
  visible: (state) => Array.isArray(state.scratch) && state.scratch.length > 0,
  summary(state) {
    const count = (state.scratch as Array<unknown> | undefined)?.length ?? 0
    return `${count} ${count === 1 ? "entry" : "entries"}`
  },
  Actions: ScratchActions,
  Component: ScratchSection,
})

registerToolRenderer("scratch_put", {
  summary(block) {
    const details = toolDetails<ScratchEntry>(block)
    const name = toolArgs(block).name
    return [details.id, typeof name === "string" ? name : ""]
      .filter(Boolean)
      .join(" · ")
  },
})

registerToolRenderer("scratch_get", {
  summary(block) {
    const args = toolArgs(block)
    return [
      typeof args.id === "string" ? args.id : "",
      typeof args.grep === "string" ? `grep ${args.grep}` : "",
    ]
      .filter(Boolean)
      .join(" · ")
  },
})
