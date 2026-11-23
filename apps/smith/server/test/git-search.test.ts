/**
 * The history search of the git service (`searchCommits`) on a temporary
 * repository: each mode, the limit, option-like text, and paths outside the
 * repository.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"

import * as git from "../src/services/git.ts"
import { tempDir } from "./support.ts"

function run(cwd: string, args: Array<string>, author = "Alice Example") {
  execFileSync("git", ["-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: "dev@example.com",
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: "dev@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdio: "ignore",
  })
}

async function commit(
  cwd: string,
  file: string,
  content: string,
  message: string,
  author?: string
) {
  await mkdir(join(cwd, file, ".."), { recursive: true })
  await writeFile(join(cwd, file), content)
  run(cwd, ["add", "-A"], author)
  run(cwd, ["commit", "-q", "-m", message], author)
}

async function repo() {
  const cwd = await tempDir("smith-git-search-")
  run(cwd, ["init", "-q", "-b", "main"])
  await commit(cwd, "a.txt", "alpha\n", "Add alpha file")
  await commit(cwd, "src/b.ts", "const needle = 1\n", "Add the B module", "Bob")
  await commit(cwd, "a.txt", "alpha\nbeta\n", "Fix --all flag in alpha")
  run(cwd, ["mv", "a.txt", "renamed.txt"])
  run(cwd, ["commit", "-q", "-m", "Rename alpha"])
  await commit(cwd, "src/b.ts", "const other = 2\n", "Remove needle", "Bob")
  return cwd
}

const subjects = (rows: Array<string> | null) =>
  (rows ?? []).map((line) => line.split("\u001f").at(-1))

void test("git search finds commits by message, ignoring case", async () => {
  const cwd = await repo()
  const result = await git.searchCommits(cwd, "message", "ADD", undefined)
  assert.equal(result.mode, "message")
  assert.deepEqual(subjects(result.commits), [
    "Add the B module",
    "Add alpha file",
  ])
  assert.equal(result.commitsHasMore, false)
  // The row has the same shape as the history rows.
  const [hashes, parents, author] = result.commits![0]!.split("\u001f")
  assert.match(hashes!, /^[0-9a-f]+\t[0-9a-f]{40}$/)
  assert.match(parents!, /^[0-9a-f]{40}$/)
  assert.equal(author, "Bob")
  // The default mode is message, and the text is literal, not a pattern.
  const literal = await git.searchCommits(cwd, null, "a.d", undefined)
  assert.deepEqual(literal.commits, [])
})

void test("git search finds commits by code, author, and file", async () => {
  const cwd = await repo()
  const code = await git.searchCommits(cwd, "code", "needle", undefined)
  assert.deepEqual(subjects(code.commits), [
    "Remove needle",
    "Add the B module",
  ])
  const author = await git.searchCommits(cwd, "author", "bob", undefined)
  assert.deepEqual(subjects(author.commits), [
    "Remove needle",
    "Add the B module",
  ])
  // File history follows a rename.
  const file = await git.searchCommits(cwd, "file", "renamed.txt", undefined)
  assert.deepEqual(subjects(file.commits), [
    "Rename alpha",
    "Fix --all flag in alpha",
    "Add alpha file",
  ])
  const nested = await git.searchCommits(cwd, "file", "src/b.ts", undefined)
  assert.equal(nested.commits?.length, 2)
})

void test("git search keeps the limit and tells when there are more", async () => {
  const cwd = await repo()
  const first = await git.searchCommits(cwd, "author", "a", 2)
  assert.equal(first.commits?.length, 2)
  assert.equal(first.commitsLimit, 2)
  assert.equal(first.commitsHasMore, true)
  const all = await git.searchCommits(cwd, "author", "a", 50)
  assert.equal(all.commits?.length, 5)
  assert.equal(all.commitsHasMore, false)
})

void test("git search treats text that starts with a dash as text", async () => {
  const cwd = await repo()
  const message = await git.searchCommits(cwd, "message", "--all", undefined)
  assert.deepEqual(subjects(message.commits), ["Fix --all flag in alpha"])
  for (const mode of ["code", "author"]) {
    const result = await git.searchCommits(cwd, mode, "--all", undefined)
    assert.deepEqual(result.commits, [], mode)
  }
  const file = await git.searchCommits(cwd, "file", "--output=x", undefined)
  assert.deepEqual(file.commits, [])
})

void test("git search rejects bad input", async () => {
  const cwd = await repo()
  const rejects = (mode: string, query: string) =>
    assert.rejects(git.searchCommits(cwd, mode, query, undefined), {
      status: 400,
    })
  await rejects("file", "../outside.txt")
  await rejects("file", "src/../../outside.txt")
  await rejects("file", "/etc/passwd")
  await rejects("message", "   ")
  await rejects("message", "x".repeat(201))
  await rejects("message", "two\nlines")
  await rejects("regex", "a")
})

void test("git search outside a repository gives no commits", async () => {
  const cwd = await tempDir("smith-git-search-none-")
  const result = await git.searchCommits(cwd, "message", "a", undefined)
  assert.equal(result.commits, null)
})
