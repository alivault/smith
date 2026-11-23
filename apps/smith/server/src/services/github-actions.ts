/**
 * GitHub Actions workflow runs of a project, through `gh`: the list, one
 * run with its jobs and steps, the failed log of a job, and run again or
 * cancel. The runner and the error texts are those of `github.ts`; the log
 * is cut like the log of a pull request check (`github-prs.ts`).
 */
import { badRequest } from "../http.ts"
import { gh, ghJson } from "./github.ts"
import { logTail, type GhCheckLog } from "./github-prs.ts"

const DEFAULT_LIST_LIMIT = 30
const MAX_LIST_LIMIT = 100
const LOG_OUTPUT_LIMIT = 64 * 1024 * 1024
const LOG_TIMEOUT_MS = 60_000

// ---------------------------------------------------------------------------
// Types

export type GhRun = {
  databaseId: number
  /** The name of the workflow run. */
  name: string
  /** The commit or pull request title. */
  displayTitle: string
  /** queued, in_progress, completed, waiting, requested, or pending. */
  status: string
  /** success, failure, cancelled, skipped, timed_out, ...; empty while it runs. */
  conclusion: string
  event: string
  headBranch: string
  headSha: string
  createdAt: string
  updatedAt: string
  url: string
  workflowName: string
}

export type GhRunStep = {
  number: number
  name: string
  status: string
  conclusion: string
  startedAt: string
  completedAt: string
}

export type GhRunJob = {
  databaseId: number
  name: string
  status: string
  conclusion: string
  startedAt: string
  completedAt: string
  url: string
  steps: Array<GhRunStep>
}

export type GhRunDetail = GhRun & {
  attempt: number
  jobs: Array<GhRunJob>
}

// ---------------------------------------------------------------------------
// Input checks

/** The ID of a run or a job: digits only, so it cannot be a flag. */
export function runId(value: unknown, name = "run ID") {
  const text =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number"
        ? String(value)
        : ""
  if (!/^\d{1,20}$/.test(text)) throw badRequest(`A valid ${name} is required`)
  return text
}

/** A branch name for `--branch`. It cannot start with a dash. */
function branchFilter(value: unknown) {
  if (value === undefined || value === null) return ""
  if (typeof value !== "string") throw badRequest("branch must be a text")
  const branch = value.trim()
  if (branch.startsWith("-") || /[\s\0]/.test(branch) || branch.length > 255)
    throw badRequest(`Not a branch name: ${branch}`)
  return branch
}

// ---------------------------------------------------------------------------
// List and detail

const RUN_FIELDS =
  "databaseId,name,displayTitle,status,conclusion,event,headBranch,headSha,createdAt,updatedAt,url,workflowName"

type RawRun = Partial<GhRun>
type RawStep = Partial<GhRunStep>
type RawJob = Partial<Omit<GhRunJob, "steps">> & { steps?: Array<RawStep> }
type RawRunDetail = RawRun & { attempt?: number; jobs?: Array<RawJob> }

function run(raw: RawRun): GhRun {
  return {
    databaseId: raw.databaseId ?? 0,
    name: raw.name ?? "",
    displayTitle: raw.displayTitle ?? "",
    status: raw.status ?? "",
    conclusion: raw.conclusion ?? "",
    event: raw.event ?? "",
    headBranch: raw.headBranch ?? "",
    headSha: raw.headSha ?? "",
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? "",
    url: raw.url ?? "",
    workflowName: raw.workflowName ?? raw.name ?? "",
  }
}

/** The runs of the repository, newest first; of one branch when given. */
export async function listRuns(
  cwd: string,
  options: { branch?: unknown; limit?: number }
) {
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, Math.floor(options.limit ?? DEFAULT_LIST_LIMIT))
  )
  const branch = branchFilter(options.branch)
  const args = ["run", "list", "--limit", String(limit), "--json", RUN_FIELDS]
  if (branch) args.push("--branch", branch)
  const raw = await ghJson<Array<RawRun>>(cwd, args)
  return raw.map(run).filter((item) => item.databaseId > 0)
}

export async function viewRun(cwd: string, id: string): Promise<GhRunDetail> {
  const raw = await ghJson<RawRunDetail>(cwd, [
    "run",
    "view",
    id,
    "--json",
    `${RUN_FIELDS},attempt,jobs`,
  ])
  return {
    ...run(raw),
    attempt: raw.attempt ?? 1,
    jobs: (raw.jobs ?? []).map((job) => ({
      databaseId: job.databaseId ?? 0,
      name: job.name ?? "",
      status: job.status ?? "",
      conclusion: job.conclusion ?? "",
      startedAt: job.startedAt ?? "",
      completedAt: job.completedAt ?? "",
      url: job.url ?? "",
      steps: (job.steps ?? []).map((step, index) => ({
        number: step.number ?? index + 1,
        name: step.name ?? "",
        status: step.status ?? "",
        conclusion: step.conclusion ?? "",
        startedAt: step.startedAt ?? "",
        completedAt: step.completedAt ?? "",
      })),
    })),
  }
}

/** The end of the failed steps of a job, as for a pull request check. */
export async function jobLog(
  cwd: string,
  id: string,
  jobId: string
): Promise<GhCheckLog> {
  const output = await gh(
    cwd,
    ["run", "view", "--job", jobId, "--log-failed"],
    {
      timeoutMs: LOG_TIMEOUT_MS,
      maxBuffer: LOG_OUTPUT_LIMIT,
    }
  )
  return {
    kind: "actions",
    name: "",
    link: "",
    runId: id,
    jobId,
    ...logTail(output),
  }
}

// ---------------------------------------------------------------------------
// Writes

/** Run all jobs again, or only the failed ones. */
export async function rerunRun(cwd: string, id: string, failedOnly: boolean) {
  const args = ["run", "rerun", id]
  if (failedOnly) args.push("--failed")
  await gh(cwd, args)
}

export async function cancelRun(cwd: string, id: string) {
  await gh(cwd, ["run", "cancel", id])
}
