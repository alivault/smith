/**
 * The data of the GitHub Actions runs in the GitHub tab: the list, one run
 * with its jobs, the failed log of a job, and run again or cancel. While a
 * shown run is queued or running, its query loads again every few seconds;
 * else a `github_changed` event loads it (see `use-app-shell-agent-sync.ts`).
 */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { buildRequestUrl, fetchJson } from "@/features/smith/app-shell-utils"
import { smithQueryKeys } from "@/features/smith/query-keys"
import { isRunActive } from "@/features/smith/right-sidebar-actions-model"
import { usePrPost } from "@/features/smith/right-sidebar-prs-actions"
import { getErrorMessage } from "@/features/smith/right-sidebar-shared"
import type {
  GhRunLogResponse,
  GhRunResponse,
  GhRunsResponse,
} from "@/lib/smith/api"
import { useMachineId } from "@/lib/smith/machine-context"
import { toast } from "@/lib/smith/toast"

type GhRunsData = Extract<GhRunsResponse, { ok: true }>
type GhRunData = Extract<GhRunResponse, { ok: true }>
type GhRunLogData = Extract<GhRunLogResponse, { ok: true }>

const RUNS_STALE_MS = 30_000
/** How often a queued or running run loads again. */
export const ACTIVE_RUN_REFRESH_MS = 12_000
const LIST_LIMIT = 30

function useGet() {
  const machineId = useMachineId()
  return <T>(viewerContextId: string, path: string, params: URLSearchParams) =>
    fetchJson<T>(
      buildRequestUrl(`${path}?${params.toString()}`, {
        machineId,
        contextId: viewerContextId,
      })
    )
}

/** The runs of one branch, or of all branches when `branch` is empty. */
export function useRunList({
  viewerContextId,
  cwd,
  branch,
  enabled,
}: {
  viewerContextId: string
  cwd: string
  branch: string
  enabled: boolean
}) {
  const get = useGet()
  return useQuery({
    queryKey: smithQueryKeys.ghRunList(viewerContextId, cwd, branch),
    queryFn: async () => {
      const params = new URLSearchParams({ cwd, limit: String(LIST_LIMIT) })
      if (branch) params.set("branch", branch)
      return (
        await get<GhRunsData>(viewerContextId, "/api/github/runs", params)
      ).runs
    },
    enabled: Boolean(enabled && viewerContextId && cwd),
    staleTime: RUNS_STALE_MS,
    placeholderData: (previous) => previous,
    refetchInterval: (query) =>
      query.state.data?.some(isRunActive) ? ACTIVE_RUN_REFRESH_MS : false,
  })
}

export function useRun({
  viewerContextId,
  cwd,
  id,
  enabled,
}: {
  viewerContextId: string
  cwd: string
  id: number
  enabled: boolean
}) {
  const get = useGet()
  return useQuery({
    queryKey: smithQueryKeys.ghRun(viewerContextId, cwd, id),
    queryFn: async () =>
      (
        await get<GhRunData>(
          viewerContextId,
          `/api/github/runs/${id}`,
          new URLSearchParams({ cwd })
        )
      ).run,
    enabled: Boolean(enabled && viewerContextId && cwd),
    staleTime: RUNS_STALE_MS,
    refetchInterval: (query) =>
      query.state.data && isRunActive(query.state.data)
        ? ACTIVE_RUN_REFRESH_MS
        : false,
  })
}

/** The failed log of a finished job; it does not change. */
export function useRunJobLog({
  viewerContextId,
  cwd,
  id,
  job,
  enabled,
}: {
  viewerContextId: string
  cwd: string
  id: number
  job: number
  enabled: boolean
}) {
  const get = useGet()
  return useQuery({
    queryKey: smithQueryKeys.ghRunLog(viewerContextId, cwd, id, job),
    queryFn: async () =>
      (
        await get<GhRunLogData>(
          viewerContextId,
          `/api/github/runs/${id}/log`,
          new URLSearchParams({ cwd, job: String(job) })
        )
      ).check,
    enabled: Boolean(enabled && viewerContextId && cwd && job),
    staleTime: Infinity,
    retry: false,
  })
}

/** Run again (all jobs or the failed ones) and cancel, with toasts. */
export function useRunWrites({
  viewerContextId,
  cwd,
}: {
  viewerContextId: string
  cwd: string
}) {
  const { post, refresh } = usePrPost(viewerContextId, cwd)
  const queryClient = useQueryClient()
  const job = useMutation({
    mutationFn: async (input: {
      key: "rerun-failed" | "rerun" | "cancel"
      id: number
    }) => {
      if (input.key === "cancel") {
        await post(`/api/github/runs/${input.id}/cancel`, {})
        return "Cancelling the run"
      }
      const failedOnly = input.key === "rerun-failed"
      await post(`/api/github/runs/${input.id}/rerun`, { failedOnly })
      return failedOnly
        ? "Running the failed jobs again"
        : "Running all jobs again"
    },
    onSuccess: (message) => toast.success(message),
    onError: (error) => toast.error(getErrorMessage(error, "GitHub failed")),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: smithQueryKeys.ghRuns(viewerContextId, cwd),
        }),
        refresh(),
      ]),
  })
  const { mutate } = job
  return {
    pendingKey: job.isPending ? job.variables?.key : undefined,
    rerunFailed: React.useCallback(
      (id: number) => mutate({ key: "rerun-failed", id }),
      [mutate]
    ),
    rerunAll: React.useCallback(
      (id: number) => mutate({ key: "rerun", id }),
      [mutate]
    ),
    cancel: React.useCallback(
      (id: number) => mutate({ key: "cancel", id }),
      [mutate]
    ),
  }
}

// ---------------------------------------------------------------------------
// Open a run in the Actions segment, from a check of a pull request

/**
 * Opens a workflow run in the Actions segment of the GitHub tab. Null when
 * the machine has no Actions routes; then the checks show no link.
 */
export const OpenRunContext = React.createContext<
  ((id: number) => void) | null
>(null)

export function useOpenRun() {
  return React.useContext(OpenRunContext)
}
