/**
 * The GitHub Actions service, with a fake `gh` on PATH. The fake writes its
 * arguments to a log and prints canned JSON.
 */
import assert from "node:assert/strict"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"

import * as actions from "../src/services/github-actions.ts"
import { tempDir } from "./support.ts"

const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args }) + "\\n")
const mode = process.env.FAKE_GH_MODE || ""
if (mode === "logged-out") {
  process.stderr.write("To get started with GitHub CLI, please run:  gh auth login\\n")
  process.exit(4)
}
const out = (value) => console.log(JSON.stringify(value))
const runs = [
  { databaseId: 11, name: "CI", displayTitle: "Fix it", status: "completed", conclusion: "failure", event: "push", headBranch: "fix", headSha: "abc", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:05:00Z", url: "https://github.com/me/proj/actions/runs/11", workflowName: "CI" },
  { databaseId: 12, name: "CI", displayTitle: "More", status: "in_progress", conclusion: "", event: "pull_request", headBranch: "fix", headSha: "def", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:01:00Z", url: "https://github.com/me/proj/actions/runs/12" },
  {},
]
const [group, command] = args
if (group === "run" && command === "list") {
  out(runs)
} else if (group === "run" && command === "view" && args[2] === "--job") {
  const lines = []
  for (let i = 0; i < 300; i++) lines.push("test\\tRun tests\\t2026-01-01T00:00:00.0000000Z line " + i)
  lines.push("test\\tRun tests\\t2026-01-01T00:00:01.0000000Z ##[error]Process completed with exit code 1.")
  process.stdout.write(lines.join("\\n") + "\\n")
} else if (group === "run" && command === "view") {
  out({ ...runs[0], attempt: 2, jobs: [
    { databaseId: 33, name: "test", status: "completed", conclusion: "failure", startedAt: "s", completedAt: "c", url: "https://github.com/me/proj/actions/runs/11/job/33", steps: [
      { number: 1, name: "Set up job", status: "completed", conclusion: "success", startedAt: "s", completedAt: "c" },
      { name: "Run tests", status: "completed", conclusion: "failure" },
    ] },
    { databaseId: 22, name: "lint", status: "completed", conclusion: "success" },
  ] })
} else if (group === "run" && (command === "rerun" || command === "cancel")) {
  if (mode === "rerun-fails") {
    process.stderr.write("run 11 cannot be rerun; its workflow file may be broken\\n")
    process.exit(1)
  }
}
`

type Call = { args: Array<string> }

async function withFakeGh(
  mode: string,
  run: (cwd: string, log: () => Promise<Array<Call>>) => Promise<void>
) {
  const dir = await tempDir("smith-gh-actions-")
  const bin = join(dir, "gh")
  const logPath = join(dir, "log.jsonl")
  await writeFile(bin, FAKE_GH)
  await chmod(bin, 0o755)
  await writeFile(logPath, "")
  const saved = {
    PATH: process.env.PATH,
    FAKE_GH_LOG: process.env.FAKE_GH_LOG,
    FAKE_GH_MODE: process.env.FAKE_GH_MODE,
  }
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`
  process.env.FAKE_GH_LOG = logPath
  process.env.FAKE_GH_MODE = mode
  try {
    await run(dir, async () =>
      (await readFile(logPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call)
    )
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

void test("github actions: list, view, log, rerun and cancel", async () => {
  await withFakeGh("", async (cwd, log) => {
    const runs = await actions.listRuns(cwd, { branch: "fix", limit: 9999 })
    // A run without an ID drops out.
    assert.deepEqual(
      runs.map((run) => [run.databaseId, run.status, run.conclusion]),
      [
        [11, "completed", "failure"],
        [12, "in_progress", ""],
      ]
    )
    // Without a workflow name, the run name stands in.
    assert.equal(runs[1].workflowName, "CI")
    await actions.listRuns(cwd, {})

    const detail = await actions.viewRun(cwd, "11")
    assert.equal(detail.attempt, 2)
    assert.deepEqual(
      detail.jobs.map((job) => [job.databaseId, job.name, job.steps.length]),
      [
        [33, "test", 2],
        [22, "lint", 0],
      ]
    )
    assert.equal(detail.jobs[0].steps[1].number, 2)
    assert.equal(detail.jobs[0].steps[1].startedAt, "")

    const jobLog = await actions.jobLog(cwd, "11", "33")
    assert.equal(jobLog.kind, "actions")
    if (jobLog.kind === "actions") {
      assert.equal(jobLog.jobId, "33")
      assert.equal(jobLog.runId, "11")
      assert.equal(jobLog.truncated, true)
      const lines = jobLog.log.split("\n")
      assert.equal(lines.length, 200)
      assert.match(lines.at(-1) ?? "", /^##\[error\]Process completed/)
    }

    await actions.rerunRun(cwd, "11", true)
    await actions.rerunRun(cwd, "11", false)
    await actions.cancelRun(cwd, "12")

    const calls = (await log()).map((call) => call.args)
    assert.deepEqual(calls[0], [
      "run",
      "list",
      "--limit",
      "100",
      "--json",
      "databaseId,name,displayTitle,status,conclusion,event,headBranch,headSha,createdAt,updatedAt,url,workflowName",
      "--branch",
      "fix",
    ])
    assert.deepEqual(calls[1].slice(0, 4), ["run", "list", "--limit", "30"])
    assert.ok(!calls[1].includes("--branch"))
    assert.deepEqual(calls[2].slice(0, 4), ["run", "view", "11", "--json"])
    assert.match(calls[2][4], /,attempt,jobs$/)
    assert.deepEqual(calls.slice(3), [
      ["run", "view", "--job", "33", "--log-failed"],
      ["run", "rerun", "11", "--failed"],
      ["run", "rerun", "11"],
      ["run", "cancel", "12"],
    ])
  })
})

void test("github actions: bad input, gh errors and a logged-out gh", async () => {
  assert.throws(() => actions.runId("x"), /valid run ID/)
  assert.throws(() => actions.runId("--help"), /valid run ID/)
  assert.throws(() => actions.runId(""), /valid run ID/)
  assert.throws(() => actions.runId(undefined), /valid run ID/)
  assert.throws(() => actions.runId("1 2", "job ID"), /valid job ID/)
  assert.equal(actions.runId(" 42 "), "42")
  assert.equal(actions.runId(42), "42")
  await withFakeGh("", async (cwd, log) => {
    await assert.rejects(
      actions.listRuns(cwd, { branch: "--all" }),
      /Not a branch name/
    )
    await assert.rejects(
      actions.listRuns(cwd, { branch: "a b" }),
      /Not a branch name/
    )
    await assert.rejects(
      actions.listRuns(cwd, { branch: 5 }),
      /branch must be a text/
    )
    // Bad input never reaches gh.
    assert.deepEqual(await log(), [])
  })
  await withFakeGh("rerun-fails", async (cwd) => {
    await assert.rejects(actions.rerunRun(cwd, "11", false), /cannot be rerun/)
  })
  await withFakeGh("logged-out", async (cwd) => {
    await assert.rejects(actions.listRuns(cwd, {}), /gh is not logged in/)
    await assert.rejects(actions.viewRun(cwd, "1"), /gh is not logged in/)
    await assert.rejects(actions.cancelRun(cwd, "1"), /gh is not logged in/)
  })
})
