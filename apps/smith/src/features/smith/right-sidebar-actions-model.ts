/**
 * Pure helpers for the GitHub Actions runs of the GitHub tab: one state per
 * run, job or step, the order of the list, and durations. No React here, so
 * the unit tests can load it.
 */
import type { GhRun } from "@/lib/smith/api"

export type RunState =
  | "queued"
  | "running"
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"

const FAILED = new Set([
  "failure",
  "timed_out",
  "startup_failure",
  "action_required",
])
const SKIPPED = new Set(["skipped", "neutral", "stale"])

/** One state from the `status` and `conclusion` of a run, job or step. */
export function runState(item: {
  status: string
  conclusion: string
}): RunState {
  const status = item.status.toLowerCase()
  const conclusion = item.conclusion.toLowerCase()
  if (status !== "completed") {
    if (status === "in_progress") return "running"
    // queued, waiting, requested, pending, or unknown.
    return conclusion ? stateOfConclusion(conclusion) : "queued"
  }
  return stateOfConclusion(conclusion)
}

function stateOfConclusion(conclusion: string): RunState {
  if (conclusion === "success") return "success"
  if (FAILED.has(conclusion)) return "failure"
  if (conclusion === "cancelled") return "cancelled"
  if (SKIPPED.has(conclusion)) return "skipped"
  return conclusion ? "success" : "queued"
}

/** Queued or running: it can still change, and it can be cancelled. */
export function isActiveState(state: RunState) {
  return state === "queued" || state === "running"
}

export function isRunActive(item: { status: string; conclusion: string }) {
  return isActiveState(runState(item))
}

export const RUN_STATE_TITLES: Record<RunState, string> = {
  queued: "Queued",
  running: "In progress",
  success: "Succeeded",
  failure: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
}

/** Running and queued runs first, then the newest. */
export function sortRuns<T extends GhRun>(runs: Array<T>) {
  const time = (run: GhRun) => Date.parse(run.createdAt) || 0
  return [...runs].sort(
    (a, b) =>
      Number(isRunActive(b)) - Number(isRunActive(a)) ||
      time(b) - time(a) ||
      b.databaseId - a.databaseId
  )
}

/** "45s", "3m 12s", or "1h 4m"; empty without a start. */
export function formatDuration(
  startedAt: string,
  completedAt: string,
  now = Date.now()
) {
  const start = Date.parse(startedAt)
  // GitHub gives year 1 for a step that never started.
  if (!Number.isFinite(start) || start <= 0) return ""
  const parsedEnd = Date.parse(completedAt)
  const end = Number.isFinite(parsedEnd) && parsedEnd > 0 ? parsedEnd : now
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const EVENT_TITLES: Record<string, string> = {
  push: "Push",
  pull_request: "Pull request",
  pull_request_target: "Pull request",
  workflow_dispatch: "Manual",
  schedule: "Schedule",
  release: "Release",
  merge_group: "Merge queue",
  workflow_run: "Workflow run",
  repository_dispatch: "Dispatch",
}

/** A short name for the event that started a run. */
export function eventTitle(event: string) {
  return EVENT_TITLES[event] ?? event.replace(/_/g, " ")
}
