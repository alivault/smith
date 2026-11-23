/**
 * The GitHub Actions runs of the GitHub tab: a list of workflow runs (of
 * the current branch or of all branches), and one run with its jobs, steps
 * and failed logs, with run again and cancel. The layout is that of the
 * pull requests: a split view when the panel is wide. The data is in
 * `right-sidebar-actions-data.ts`.
 */
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  WorkflowIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { TitleTooltip } from "@/components/ui/tooltip"
import { useGitHubLive } from "@/features/smith/github-live"
import {
  useRun,
  useRunJobLog,
  useRunList,
  useRunWrites,
} from "@/features/smith/right-sidebar-actions-data"
import {
  RUN_STATE_TITLES,
  eventTitle,
  formatDuration,
  isActiveState,
  runState,
  sortRuns,
  type RunState,
} from "@/features/smith/right-sidebar-actions-model"
import { gitStatusQueryOptions } from "@/features/smith/right-sidebar-git-data"
import {
  EmptyState,
  SPLIT_VIEW_MIN_WIDTH,
  ageText,
  formatAge,
  formatFullDate,
  useElementWidth,
  useToolbarButtonSize,
} from "@/features/smith/right-sidebar-issues"
import type { AvailableRepo } from "@/features/smith/right-sidebar-issues-data"
import {
  BucketIcon,
  CheckLogView,
  Chip,
  Section,
} from "@/features/smith/right-sidebar-prs"
import { GitSectionNote } from "@/features/smith/right-sidebar-section-note"
import { getErrorMessage } from "@/features/smith/right-sidebar-shared"
import { useIsMobile } from "@/hooks/use-mobile"
import type { GhRun, GhRunDetail, GhRunJob } from "@/lib/smith/api"
import { safeLocalStorageGetItem, safeLocalStorageSetItem } from "@/lib/smith"
import { useMachineId } from "@/lib/smith/machine-context"
import { cn } from "@/lib/utils"

type RunFilter = "branch" | "all"
const FILTER_STORAGE_KEY = "smith.github.runFilter"

function readFilter(): RunFilter {
  return safeLocalStorageGetItem(FILTER_STORAGE_KEY) === "all"
    ? "all"
    : "branch"
}

// ---------------------------------------------------------------------------
// Small parts

const STATE_BUCKETS: Record<RunState, string> = {
  queued: "pending",
  running: "pending",
  success: "pass",
  failure: "fail",
  cancelled: "cancel",
  skipped: "skipping",
}

/** The icon of a run, job or step: the check icons, and a spinner while it runs. */
export function RunStateIcon({
  state,
  className,
}: {
  state: RunState
  className?: string
}) {
  if (state === "running")
    return (
      <Spinner
        aria-label={RUN_STATE_TITLES.running}
        className={cn("text-amber-500", className)}
      />
    )
  return (
    <BucketIcon
      bucket={STATE_BUCKETS[state]}
      className={className}
      aria-label={RUN_STATE_TITLES[state]}
    />
  )
}

function StatePill({ state }: { state: RunState }) {
  return (
    <Chip
      title={RUN_STATE_TITLES[state]}
      className={cn(
        "px-2 font-semibold",
        state === "success" &&
          "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
        state === "failure" && "bg-red-500/15 text-red-700 dark:text-red-300",
        isActiveState(state) &&
          "bg-amber-500/15 text-amber-700 dark:text-amber-300"
      )}
    >
      <RunStateIcon state={state} className="size-3 text-current" />
      {RUN_STATE_TITLES[state]}
    </Chip>
  )
}

// ---------------------------------------------------------------------------
// The list

function RunRow({
  run,
  selected,
  onOpen,
}: {
  run: GhRun
  selected: boolean
  onOpen: () => void
}) {
  const state = runState(run)
  return (
    <div
      className={cn(
        "flex min-h-11 w-full min-w-0 items-start gap-0.5 rounded-lg pl-1",
        selected ? "bg-primary/10" : "hover:bg-muted/70"
      )}
    >
      <TitleTooltip title={RUN_STATE_TITLES[state]}>
        <span className="flex size-8 shrink-0 items-center justify-center pt-1">
          <RunStateIcon state={state} className="size-4" />
        </span>
      </TitleTooltip>
      <div
        data-row-separator
        className="grid min-w-0 flex-1 gap-1 border-b border-border/60 py-2 pr-2.5 pl-1"
      >
        <button
          type="button"
          aria-current={selected || undefined}
          onClick={onOpen}
          className="grid min-w-0 gap-0.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-5 font-semibold wrap-break-word">
              {run.displayTitle || run.workflowName}
            </span>
            <span
              className="shrink-0 text-xs text-muted-foreground tabular-nums"
              title={formatFullDate(run.createdAt)}
            >
              {formatAge(run.createdAt)}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="max-w-[50%] shrink-0 truncate">
              {run.workflowName}
            </span>
            <span
              className="min-w-0 truncate font-mono text-[11px]"
              title={run.headBranch}
            >
              {run.headBranch}
            </span>
            <span className="ml-auto shrink-0">{eventTitle(run.event)}</span>
          </span>
        </button>
      </div>
    </div>
  )
}

function RunList({
  repo,
  runs,
  loading,
  error,
  stale,
  filter,
  branch,
  branchPending,
  selectedId,
  onFilterChange,
  onRefresh,
  onOpen,
}: {
  repo: AvailableRepo
  runs: Array<GhRun> | undefined
  loading: boolean
  error: unknown
  stale: boolean
  filter: RunFilter
  branch: string
  branchPending: boolean
  selectedId: number | null
  onFilterChange: (filter: RunFilter) => void
  onRefresh: () => void
  onOpen: (id: number) => void
}) {
  const isMobile = useIsMobile()
  const buttonSize = useToolbarButtonSize()
  const sorted = React.useMemo(
    () => (runs ? sortRuns(runs) : undefined),
    [runs]
  )
  const noBranch = filter === "branch" && !branch
  let body: React.ReactNode
  if (noBranch && branchPending) {
    body = (
      <GitSectionNote className="px-2 py-2">
        <Spinner /> Looking for the branch…
      </GitSectionNote>
    )
  } else if (noBranch) {
    body = (
      <EmptyState
        icon={<GitBranchIcon />}
        title="No Branch"
        description="This folder has no branch checked out. Choose All Branches to see all runs."
      />
    )
  } else if (loading && !sorted) {
    body = (
      <GitSectionNote className="px-2 py-2">
        <Spinner /> Loading workflow runs…
      </GitSectionNote>
    )
  } else if (error && !sorted) {
    body = (
      <GitSectionNote tone="destructive" className="px-2 py-2">
        {getErrorMessage(error, "Failed to load workflow runs")}
      </GitSectionNote>
    )
  } else if (sorted && sorted.length > 0) {
    body = sorted.map((run) => (
      <RunRow
        key={run.databaseId}
        run={run}
        selected={selectedId === run.databaseId}
        onOpen={() => onOpen(run.databaseId)}
      />
    ))
  } else {
    body = (
      <EmptyState
        icon={<WorkflowIcon />}
        title="No Workflow Runs"
        description={
          filter === "branch"
            ? `No GitHub Actions runs on ${branch}.`
            : "This repository has no GitHub Actions runs."
        }
      />
    )
  }
  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1.5">
        <ToggleGroup
          variant="outline"
          size={isMobile ? "default" : "sm"}
          className="flex-1"
          value={[filter]}
          onValueChange={(values) => {
            const value = values[0]
            if (value === "branch" || value === "all") onFilterChange(value)
          }}
        >
          <ToggleGroupItem
            value="branch"
            className="flex-1"
            title={branch || undefined}
          >
            This Branch
          </ToggleGroupItem>
          <ToggleGroupItem value="all" className="flex-1">
            All Branches
          </ToggleGroupItem>
        </ToggleGroup>
        <TitleTooltip title="Refresh">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh"
            className={buttonSize}
            disabled={noBranch}
            onClick={onRefresh}
          >
            {loading && sorted ? <Spinner size="xs" /> : <RefreshCwIcon />}
          </Button>
        </TitleTooltip>
        <TitleTooltip title="Open on GitHub">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Open the workflow runs on GitHub"
            className={buttonSize}
            render={
              <a
                href={`${repo.url}/actions`}
                target="_blank"
                rel="noreferrer"
              />
            }
          >
            <ExternalLinkIcon />
          </Button>
        </TitleTooltip>
      </div>
      <div
        className={cn(
          "safe-scroll-end min-h-0 flex-1 overflow-y-auto px-1 pb-2 transition-opacity [&>*:last-child_[data-row-separator]]:border-transparent",
          stale && "opacity-50"
        )}
      >
        {body}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The run

function JobLog({
  viewerContextId,
  cwd,
  runId,
  job,
}: {
  viewerContextId: string
  cwd: string
  runId: number
  job: GhRunJob
}) {
  const logQuery = useRunJobLog({
    viewerContextId,
    cwd,
    id: runId,
    job: job.databaseId,
    enabled: true,
  })
  return <CheckLogView query={logQuery} />
}

function JobRow({
  viewerContextId,
  cwd,
  runId,
  job,
}: {
  viewerContextId: string
  cwd: string
  runId: number
  job: GhRunJob
}) {
  const state = runState(job)
  const failed = state === "failure"
  const [open, setOpen] = React.useState(failed)
  return (
    <div className="grid gap-1 py-0.5">
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <ChevronDownIcon className="size-3 shrink-0" />
          ) : (
            <ChevronRightIcon className="size-3 shrink-0" />
          )}
          <RunStateIcon state={state} />
          <span className="min-w-0 flex-1 truncate">{job.name}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {formatDuration(job.startedAt, job.completedAt)}
          </span>
        </button>
        {job.url ? (
          <TitleTooltip title="Open the job">
            <a
              href={job.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open the job ${job.name}`}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            >
              <ExternalLinkIcon className="size-3" />
            </a>
          </TitleTooltip>
        ) : null}
      </div>
      {open ? (
        <div className="grid gap-1 pl-[1.125rem]">
          {job.steps.length === 0 ? (
            <GitSectionNote className="min-h-6 px-1 text-xs">
              No steps yet.
            </GitSectionNote>
          ) : (
            <ol className="grid gap-0.5">
              {job.steps.map((step) => {
                const stepState = runState(step)
                return (
                  <li
                    key={step.number}
                    className={cn(
                      "flex min-w-0 items-center gap-1.5 text-xs",
                      stepState === "skipped" && "text-muted-foreground"
                    )}
                  >
                    <RunStateIcon state={stepState} className="size-3" />
                    <span className="min-w-0 flex-1 truncate">{step.name}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                      {formatDuration(step.startedAt, step.completedAt)}
                    </span>
                  </li>
                )
              })}
            </ol>
          )}
          {failed ? (
            <JobLog
              viewerContextId={viewerContextId}
              cwd={cwd}
              runId={runId}
              job={job}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function RunButtons({
  viewerContextId,
  cwd,
  run,
}: {
  viewerContextId: string
  cwd: string
  run: GhRunDetail
}) {
  const writes = useRunWrites({ viewerContextId, cwd })
  const buttonSize = useToolbarButtonSize()
  const state = runState(run)
  const active = isActiveState(state)
  const anyFailed =
    state === "failure" ||
    state === "cancelled" ||
    run.jobs.some((job) => {
      const jobState = runState(job)
      return jobState === "failure" || jobState === "cancelled"
    })
  const busy = writes.pendingKey !== undefined
  const icon = (key: string, Icon: typeof RotateCcwIcon) =>
    writes.pendingKey === key ? (
      <Spinner size="xs" data-icon="inline-start" />
    ) : (
      <Icon data-icon="inline-start" />
    )
  const className = cn(buttonSize && "h-11")
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {!active && anyFailed ? (
        <Button
          type="button"
          size="sm"
          variant="default"
          className={className}
          disabled={busy}
          onClick={() => writes.rerunFailed(run.databaseId)}
        >
          {icon("rerun-failed", RotateCcwIcon)}
          Rerun Failed Jobs
        </Button>
      ) : null}
      {!active ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={className}
          disabled={busy}
          onClick={() => writes.rerunAll(run.databaseId)}
        >
          {icon("rerun", RotateCcwIcon)}
          Rerun All Jobs
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={className}
          disabled={busy}
          onClick={() => writes.cancel(run.databaseId)}
        >
          {icon("cancel", CircleSlashIcon)}
          Cancel Run
        </Button>
      )}
    </div>
  )
}

function RunDetail({
  viewerContextId,
  cwd,
  repo,
  id,
  active,
  summary,
  onBack,
}: {
  viewerContextId: string
  cwd: string
  repo: AvailableRepo
  id: number
  active: boolean
  /** The run from the list, while the full one loads. */
  summary?: GhRun
  onBack?: () => void
}) {
  const buttonSize = useToolbarButtonSize()
  const runQuery = useRun({ viewerContextId, cwd, id, enabled: active })
  const run = runQuery.data
  const shown = run ?? summary
  const state = shown ? runState(shown) : undefined
  const url = shown?.url || `${repo.url}/actions/runs/${id}`
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/60 px-1.5">
        {onBack ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("gap-0.5 px-1.5 text-primary", buttonSize && "h-11")}
            onClick={onBack}
          >
            <ChevronLeftIcon className="size-5" />
            Actions
          </Button>
        ) : null}
        <span
          className={cn(
            "min-w-0 truncate text-sm font-semibold",
            !onBack && "pl-1.5"
          )}
        >
          {shown?.workflowName}
        </span>
        <span className="min-w-0 flex-1" />
        {runQuery.isFetching ? <Spinner size="xs" /> : null}
        <TitleTooltip title="Refresh">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh"
            className={buttonSize}
            onClick={() => void runQuery.refetch()}
          >
            <RefreshCwIcon />
          </Button>
        </TitleTooltip>
        <TitleTooltip title="Open on GitHub">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Open on GitHub"
            className={buttonSize}
            render={<a href={url} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon />
          </Button>
        </TitleTooltip>
      </div>
      <div className="safe-scroll-end min-h-0 flex-1 overflow-y-auto">
        {!shown && runQuery.isPending ? (
          <GitSectionNote className="px-4 py-3">
            <Spinner /> Loading the run…
          </GitSectionNote>
        ) : !shown ? (
          <GitSectionNote tone="destructive" className="px-4 py-3">
            {getErrorMessage(runQuery.error, "Failed to load the run")}
          </GitSectionNote>
        ) : (
          <article className="grid grid-cols-[minmax(0,1fr)] gap-3 px-4 pt-3 pb-4">
            <header className="grid gap-1.5">
              <h2 className="text-lg leading-6 font-semibold wrap-break-word">
                {shown.displayTitle || shown.workflowName}
              </h2>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                {state ? <StatePill state={state} /> : null}
                <span>{eventTitle(shown.event)}</span>
                <span
                  className="min-w-0 truncate font-mono text-[11px]"
                  title={shown.headBranch}
                >
                  {shown.headBranch}
                </span>
                {shown.headSha ? (
                  <span className="font-mono text-[11px]">
                    {shown.headSha.slice(0, 7)}
                  </span>
                ) : null}
                {shown.createdAt ? (
                  <span title={formatFullDate(shown.createdAt)}>
                    started {ageText(shown.createdAt)}
                  </span>
                ) : null}
                {run && run.attempt > 1 ? (
                  <span>attempt {run.attempt}</span>
                ) : null}
              </div>
              {run && repo.viewerCanWrite ? (
                <div className="pt-1">
                  <RunButtons
                    viewerContextId={viewerContextId}
                    cwd={cwd}
                    run={run}
                  />
                </div>
              ) : null}
            </header>
            {runQuery.error && run ? (
              <GitSectionNote tone="destructive">
                {getErrorMessage(runQuery.error, "Failed to load the run")}
              </GitSectionNote>
            ) : null}
            {!run ? (
              <GitSectionNote>
                <Spinner /> Loading the jobs…
              </GitSectionNote>
            ) : (
              <Section title="Jobs" count={run.jobs.length}>
                {run.jobs.length === 0 ? (
                  <GitSectionNote className="px-1">No jobs yet.</GitSectionNote>
                ) : (
                  run.jobs.map((job) => (
                    <JobRow
                      key={job.databaseId}
                      viewerContextId={viewerContextId}
                      cwd={cwd}
                      runId={id}
                      job={job}
                    />
                  ))
                )}
              </Section>
            )}
          </article>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The panel

export function ActionsPanel({
  viewerContextId,
  cwd,
  repo,
  active,
  requested,
}: {
  viewerContextId: string
  cwd: string
  repo: AvailableRepo
  active: boolean
  /** A run to open, from a check of a pull request. */
  requested: { id: number; at: number } | null
}) {
  const machineId = useMachineId()
  const [filter, setFilterState] = React.useState<RunFilter>(readFilter)
  const [openId, setOpenId] = React.useState<number | null>(
    requested?.id ?? null
  )
  const { ref: panelRef, width } = useElementWidth()
  const split = width >= SPLIT_VIEW_MIN_WIDTH
  useGitHubLive({ viewerContextId, cwd, enabled: active })
  const branchQuery = useQuery({
    ...gitStatusQueryOptions({ machineId, viewerContextId, cwd }),
    enabled: active && filter === "branch",
    select: (data) => data.gitStatus?.branch ?? "",
    notifyOnChangeProps: ["data", "isPending"],
  })
  const branch = branchQuery.data ?? ""
  const listBranch = filter === "branch" ? branch : ""
  const listQuery = useRunList({
    viewerContextId,
    cwd,
    branch: listBranch,
    enabled: active && (filter === "all" || Boolean(branch)),
  })

  React.useEffect(() => {
    if (requested) setOpenId(requested.id)
  }, [requested])

  const setFilter = (value: RunFilter) => {
    setFilterState(value)
    safeLocalStorageSetItem(FILTER_STORAGE_KEY, value)
  }

  const list = (
    <RunList
      repo={repo}
      runs={listQuery.data}
      loading={listQuery.isFetching}
      error={listQuery.error}
      stale={listQuery.isPlaceholderData}
      filter={filter}
      branch={branch}
      branchPending={branchQuery.isPending}
      selectedId={split ? openId : null}
      onFilterChange={setFilter}
      onRefresh={() => void listQuery.refetch()}
      onOpen={setOpenId}
    />
  )
  const detail =
    openId !== null ? (
      <RunDetail
        key={openId}
        viewerContextId={viewerContextId}
        cwd={cwd}
        repo={repo}
        id={openId}
        active={active}
        summary={listQuery.data?.find((run) => run.databaseId === openId)}
        onBack={split ? undefined : () => setOpenId(null)}
      />
    ) : null

  return (
    <div ref={panelRef} className="h-full min-h-0">
      {split ? (
        <div className="flex h-full min-h-0">
          <div className="h-full w-[clamp(260px,38%,380px)] shrink-0 border-r border-border/60">
            {list}
          </div>
          <div className="h-full min-w-0 flex-1">
            {detail ?? (
              <EmptyState
                icon={<WorkflowIcon />}
                title="No Run Selected"
                description="Choose a workflow run in the list."
              />
            )}
          </div>
        </div>
      ) : (
        <>
          <div className={cn("h-full", detail && "hidden")}>{list}</div>
          {detail}
        </>
      )}
    </div>
  )
}
