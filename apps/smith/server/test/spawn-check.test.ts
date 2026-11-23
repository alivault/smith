import assert from "node:assert/strict"
import { test } from "node:test"

import {
  BUILTIN_PROFILES,
  findProfile,
  goalChangeIntent,
  missingToolsText,
  PROFILE_GUIDE,
  spawnRefusal,
  toolAccess,
} from "../src/core/profiles.ts"
import { createAgentsExtension } from "../src/extensions/agents.ts"
import { HostBridge } from "../src/extensions/host.ts"

void test("goalChangeIntent finds goals that change files or the repository", () => {
  const positives: Array<[string, RegExp]> = [
    ["Fix the bug in src/core/app.ts.", /Fix the bug in src\/core\/app\.ts/],
    ["Commit in logical commits and push the branch.", /^Commit$/],
    ["Run the tests, then commit.", /then commit/],
    ["Please push it to origin.", /Please push/],
    ["Then open a PR.", /open a PR/],
    ["Open a draft pull request for the change", /Open a draft pull request/],
    ["Write the summary to /tmp/report.md", /Write the summary to/],
    ["Create notes.md with the findings", /Create notes\.md/],
    ["Save the results to out/data/results.json", /Save the results/],
    ["Edit apps/smith/server/src/api.ts", /Edit apps/],
    ["You must update README.md", /You must update README\.md/],
    ["- Add tests to test/app.test.ts", /Add tests to test\/app\.test\.ts/],
    ["Merge the branch into main", /Merge/],
    ["Do not push. Commit the result.", /Commit/],
    ["Run gh pr create --fill", /gh pr create/],
  ]
  for (const [goal, expected] of positives)
    assert.match(goalChangeIntent(goal) ?? "(none)", expected, goal)
})

void test("goalChangeIntent ignores reviews, reads, and negations", () => {
  const negatives = [
    "Review the last 3 commits. Do not change files.",
    "Review the diff; do not commit or push.",
    "Don't commit anything, only report.",
    "Never commit, never push. Report with file and line.",
    "Do not edit server/src/x.ts, only report.",
    "Read src/a.ts and report what to fix in src/a.ts.",
    "Check whether the commit message follows the style",
    "Explain how push notifications work in app/push/x.ts",
    "Find merge conflicts and explain them",
    "Research the API and write a short report",
    "Look at the first commit",
    "Create a plan for src/x.ts",
    "Investigate why gh pr create fails",
    "Check how to open a PR",
    "Add tests and/or docs",
    "Audit git log and rg for TODOs without changing files",
    "Summarize what each commit does",
  ]
  for (const goal of negatives)
    assert.equal(goalChangeIntent(goal), undefined, goal)
})

void test("toolAccess and missingToolsText follow the profile and the limits", () => {
  const reviewer = findProfile("reviewer")
  assert.deepEqual(toolAccess(reviewer, undefined), {
    write: false,
    edit: false,
    bash: "sandbox",
  })
  assert.equal(
    missingToolsText(toolAccess(reviewer, undefined)),
    "No: write, edit; bash is sandboxed (read-only, no network)"
  )
  assert.equal(
    missingToolsText(toolAccess(findProfile("researcher"), undefined)),
    "No: write, edit; bash is sandboxed (read-only, with network)"
  )
  // A parent that adds bash gives bash without the sandbox.
  assert.equal(
    missingToolsText(toolAccess(reviewer, { add: ["write", "edit", "bash"] })),
    ""
  )
  assert.equal(
    missingToolsText(toolAccess(findProfile("builder"), { remove: ["bash"] })),
    "No: bash"
  )
  assert.equal(missingToolsText(toolAccess(findProfile("full"), {})), "")
  assert.equal(
    missingToolsText(
      toolAccess({ name: "x", description: "", extensions: ["smith"] }, {})
    ),
    "No: write, edit, bash"
  )
  assert.equal(
    missingToolsText(
      toolAccess({ name: "x", description: "", bash: "sandbox" }, {})
    ),
    "Bash is sandboxed (read-only, no network)"
  )
})

void test("spawnRefusal refuses a change goal and a missing sandbox, and names the fix", () => {
  const change = spawnRefusal({
    goal: "Fix src/app.ts and commit.",
    profile: findProfile("reviewer"),
    sandbox: true,
  })
  assert.match(change ?? "", /The goal asks to change files/)
  assert.match(change ?? "", /profile: "builder"/)
  assert.match(change ?? "", /add: \["write", "edit", "bash"\]/)
  assert.match(change ?? "", /force: true/)
  assert.equal(
    spawnRefusal({
      goal: "Fix src/app.ts and commit.",
      profile: findProfile("builder"),
      sandbox: false,
    }),
    undefined
  )
  assert.equal(
    spawnRefusal({
      goal: "Review the diff. Do not commit.",
      profile: findProfile("reviewer"),
      sandbox: true,
    }),
    undefined
  )
  const noSandbox = spawnRefusal({
    goal: "Review the diff.",
    profile: findProfile("read-only"),
    sandbox: false,
  })
  assert.match(noSandbox ?? "", /this machine has none/)
  assert.match(noSandbox ?? "", /add: \["bash"\]/)
  // With bash added, the sandbox does not matter.
  assert.equal(
    spawnRefusal({
      goal: "Review the diff.",
      profile: findProfile("read-only"),
      limits: { add: ["bash"] },
      sandbox: false,
    }),
    undefined
  )
})

void test("the spawn_subagent description has a line for each built-in profile", () => {
  const spawn = createAgentsExtension(new HostBridge()).tools?.find(
    (tool) => tool.name === "spawn_subagent"
  )
  assert.ok(spawn)
  for (const profile of BUILTIN_PROFILES) {
    assert.ok(PROFILE_GUIDE.includes(`${profile.name}:`), profile.name)
    assert.ok(spawn.description.includes(`${profile.name}:`), profile.name)
  }
  assert.match(spawn.description, /use builder or full/)
  assert.match(spawn.description, /force: true/)
})
