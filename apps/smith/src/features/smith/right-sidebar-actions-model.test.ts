import { describe, expect, it } from "vite-plus/test"

import {
  eventTitle,
  formatDuration,
  isRunActive,
  runState,
  sortRuns,
} from "@/features/smith/right-sidebar-actions-model"
import type { GhRun } from "@/lib/smith/api"

function run(
  id: number,
  createdAt: string,
  status = "completed",
  conclusion = "success"
): GhRun {
  return {
    databaseId: id,
    name: "CI",
    displayTitle: `Run ${id}`,
    status,
    conclusion,
    event: "push",
    headBranch: "main",
    headSha: "",
    createdAt,
    updatedAt: createdAt,
    url: "",
    workflowName: "CI",
  }
}

describe("runState", () => {
  it("maps status and conclusion to one state", () => {
    expect(runState({ status: "queued", conclusion: "" })).toBe("queued")
    expect(runState({ status: "waiting", conclusion: "" })).toBe("queued")
    expect(runState({ status: "pending", conclusion: "" })).toBe("queued")
    expect(runState({ status: "in_progress", conclusion: "" })).toBe("running")
    expect(runState({ status: "completed", conclusion: "success" })).toBe(
      "success"
    )
    expect(runState({ status: "completed", conclusion: "failure" })).toBe(
      "failure"
    )
    expect(runState({ status: "completed", conclusion: "timed_out" })).toBe(
      "failure"
    )
    expect(
      runState({ status: "completed", conclusion: "startup_failure" })
    ).toBe("failure")
    expect(runState({ status: "completed", conclusion: "cancelled" })).toBe(
      "cancelled"
    )
    expect(runState({ status: "completed", conclusion: "skipped" })).toBe(
      "skipped"
    )
    expect(runState({ status: "completed", conclusion: "neutral" })).toBe(
      "skipped"
    )
    // gh shows the GraphQL casing for steps of some runs.
    expect(runState({ status: "COMPLETED", conclusion: "FAILURE" })).toBe(
      "failure"
    )
  })

  it("knows active runs", () => {
    expect(isRunActive({ status: "queued", conclusion: "" })).toBe(true)
    expect(isRunActive({ status: "in_progress", conclusion: "" })).toBe(true)
    expect(isRunActive({ status: "completed", conclusion: "failure" })).toBe(
      false
    )
  })
})

describe("sortRuns", () => {
  it("puts running and queued runs first, then the newest", () => {
    const runs = [
      run(1, "2026-01-01T00:00:00Z"),
      run(2, "2026-01-03T00:00:00Z"),
      run(3, "2026-01-02T00:00:00Z", "in_progress", ""),
      run(4, "2025-12-01T00:00:00Z", "queued", ""),
    ]
    expect(sortRuns(runs).map((item) => item.databaseId)).toEqual([3, 4, 2, 1])
    // The input does not change.
    expect(runs.map((item) => item.databaseId)).toEqual([1, 2, 3, 4])
  })
})

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:45Z")).toBe(
      "45s"
    )
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T00:03:12Z")).toBe(
      "3m 12s"
    )
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T01:04:00Z")).toBe(
      "1h 4m"
    )
    expect(formatDuration("", "")).toBe("")
  })

  it("counts a running job to now", () => {
    const now = Date.parse("2026-01-01T00:00:30Z")
    expect(formatDuration("2026-01-01T00:00:00Z", "", now)).toBe("30s")
  })
})

describe("eventTitle", () => {
  it("names common events and keeps others readable", () => {
    expect(eventTitle("pull_request")).toBe("Pull request")
    expect(eventTitle("workflow_dispatch")).toBe("Manual")
    expect(eventTitle("check_suite")).toBe("check suite")
  })
})
