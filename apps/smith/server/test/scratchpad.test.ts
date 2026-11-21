import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import {
  mkdir,
  readdir,
  readFile,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import { AgentMetaDoc, publicId } from "../src/core/agents.ts"
import {
  Scratchpad,
  SCRATCH_MAX_AGE_MS,
  SCRATCH_MAX_ENTRIES,
  SCRATCH_MIN_AGE_MS,
} from "../src/extensions/scratchpad.ts"
import { openHarness, tempDir, TEST_MODEL } from "./support.ts"

const MINUTE = 60 * 1000

/** Write an entry as `put` does, with a chosen time. */
async function seed(
  dataDir: string,
  conversation: number | string,
  id: string,
  createdAt: number,
  text = "hello"
) {
  const dir = join(dataDir, "scratch", String(conversation))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${id}.txt`), text)
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      bytes: text.length,
      lines: 1,
      createdAt,
    })
  )
}

function entryId(index: number) {
  return `x${String(index).padStart(8, "0")}`
}

async function ids(dataDir: string, conversation: number | string) {
  const names = await readdir(
    join(dataDir, "scratch", String(conversation))
  ).catch(() => [] as string[])
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort()
}

/** Make a folder look older than the sweep's guard. */
async function age(path: string, ms: number) {
  const time = new Date(Date.now() - ms)
  await utimes(path, time, time)
}

void test("put keeps the newest entries and drops old ones", async () => {
  const data = await tempDir("smith-scratch-test-")
  const scratch = new Scratchpad(data)
  const now = Date.now()
  // Old beyond the limit of age, but one of them is younger than the guard.
  await seed(data, 7, "xold00001", now - SCRATCH_MAX_AGE_MS - MINUTE)
  // Beyond the count limit: entries 20 minutes old.
  for (let index = 0; index < SCRATCH_MAX_ENTRIES + 3; index++)
    await seed(data, 7, entryId(index), now - 20 * MINUTE - index)
  const fresh = await scratch.put(7, "fresh", { name: "fresh" })
  const kept = await ids(data, 7)
  assert.equal(kept.length, SCRATCH_MAX_ENTRIES)
  assert.ok(kept.includes(fresh.id))
  assert.ok(!kept.includes("xold00001"), "too old")
  // The newest 49 of the 20-minute-old entries stay: indexes 0 to 48.
  assert.ok(kept.includes(entryId(48)))
  assert.ok(!kept.includes(entryId(49)))
  assert.ok(!existsSync(join(data, "scratch", "7", `${entryId(52)}.txt`)))
})

void test("put never drops an entry younger than ten minutes", async () => {
  const data = await tempDir("smith-scratch-test-")
  const scratch = new Scratchpad(data)
  const now = Date.now()
  for (let index = 0; index < SCRATCH_MAX_ENTRIES + 5; index++)
    await seed(data, 3, entryId(index), now - SCRATCH_MIN_AGE_MS / 2 - index)
  await scratch.put(3, "one more")
  assert.equal((await ids(data, 3)).length, SCRATCH_MAX_ENTRIES + 6)
  // Later, the seeded entries are old enough to go; the one of `put` is
  // still too young, but it is the newest, so it counts in the 50.
  const later = await scratch.prune(3, now + SCRATCH_MIN_AGE_MS)
  assert.equal(later.removedEntries, 6)
  assert.equal((await ids(data, 3)).length, SCRATCH_MAX_ENTRIES)
})

void test("the sweep removes orphans and keeps everything else", async () => {
  const data = await tempDir("smith-scratch-test-")
  const scratch = new Scratchpad(data)
  const now = Date.now()
  const root = join(data, "scratch")
  await seed(data, 1, "xkeep0001", now - MINUTE)
  await seed(data, 1, "xstale001", now - SCRATCH_MAX_AGE_MS - MINUTE)
  await seed(data, 2, "xorphan01", now - MINUTE, "12345")
  await age(join(root, "2"), 20 * MINUTE)
  // A folder of a conversation made while the sweep ran: too new to go.
  await seed(data, 4, "xnew00001", now)
  // Names that are not conversation IDs stay.
  await mkdir(join(root, "notes"))
  await writeFile(join(root, "notes", "a.txt"), "a")
  await age(join(root, "notes"), 20 * MINUTE)
  await writeFile(join(root, "5"), "a file, not a folder")
  // A link to a folder outside is not followed.
  const outside = join(data, "outside")
  await mkdir(outside)
  await writeFile(join(outside, "precious.txt"), "keep")
  await symlink(outside, join(root, "6"))

  const result = await scratch.sweep(new Set(["1"]), now)
  assert.equal(result.removedFolders, 1)
  assert.equal(result.removedEntries, 1)
  assert.ok(result.freedBytes >= 10)
  assert.ok(!existsSync(join(root, "2")))
  assert.deepEqual(await ids(data, 1), ["xkeep0001"])
  assert.deepEqual(await ids(data, 4), ["xnew00001"])
  assert.ok(existsSync(join(root, "notes", "a.txt")))
  assert.ok(existsSync(join(root, "5")))
  assert.ok(existsSync(join(root, "6")))
  assert.equal(await readFile(join(outside, "precious.txt"), "utf8"), "keep")

  // Without the list of conversations, no folder goes as a whole.
  await seed(data, 8, "xorphan02", now - MINUTE)
  await age(join(root, "8"), 20 * MINUTE)
  const unsure = await scratch.sweep(undefined, now)
  assert.equal(unsure.removedFolders, 0)
  assert.deepEqual(await ids(data, 8), ["xorphan02"])
})

void test("the server sweeps at startup and deletes entries on request", async () => {
  const data = await tempDir("smith-scratch-test-")
  const harness = await openHarness(
    join(data, "smith.sqlite"),
    [],
    () => ({ text: "ok" }),
    data
  )
  let id = ""
  let conversationId = 0
  try {
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { cwd: data, model: TEST_MODEL },
        init: async (tx, created) => {
          Object.assign(await tx.doc(AgentMetaDoc, created), {
            cwd: data,
            name: "Scratch",
            createdAt: Date.now(),
            modifiedAt: Date.now(),
            firstMessage: "Scratch",
            messageCount: 1,
          })
        },
      },
      ctx
    )
    id = publicId(conversation.id)
    conversationId = Number(conversation.id)
  } finally {
    await harness.close(ctx)
  }
  const now = Date.now()
  const root = join(data, "scratch")
  await seed(data, conversationId, "xentry001", now - MINUTE)
  await seed(data, conversationId, "xentry002", now - MINUTE)
  await seed(data, conversationId, "xentry003", now - MINUTE)
  await seed(data, 9999, "xorphan01", now - MINUTE)
  await age(join(root, "9999"), 20 * MINUTE)
  await mkdir(join(root, "other"))
  await age(join(root, "other"), 20 * MINUTE)

  const child = spawn(
    process.execPath,
    [
      "dist/smith-server.mjs",
      "serve",
      "--port",
      "0",
      "--data-dir",
      data,
      "--web-dir",
      "none",
    ],
    {
      env: { ...process.env, PI_CODING_AGENT_DIR: join(data, "agent") },
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  let log = ""
  child.stdout.on("data", (chunk) => {
    log += chunk.toString()
  })
  child.stderr.on("data", (chunk) => {
    log += chunk.toString()
  })
  const exited = new Promise<void>((done) => child.once("exit", () => done()))
  try {
    let port: number | undefined
    for (let i = 0; i < 100; i++) {
      try {
        port = JSON.parse(
          await readFile(join(data, "server.json"), "utf8")
        ).port
        break
      } catch {
        /* Wait for startup. */
      }
      if (child.exitCode !== null) throw new Error(log)
      await new Promise((done) => setTimeout(done, 100))
    }
    assert.ok(port, log)
    for (let i = 0; i < 100 && !log.includes("scratchpad: freed"); i++)
      await new Promise((done) => setTimeout(done, 50))
    assert.match(log, /scratchpad: freed .* \(1 folders/)
    assert.ok(!existsSync(join(root, "9999")), "the orphan goes")
    assert.ok(existsSync(join(root, "other")), "other names stay")
    assert.equal((await ids(data, conversationId)).length, 3)

    const url = `http://127.0.0.1:${port}`
    const remove = (query: string) =>
      fetch(`${url}/api/agent/scratch?agent=${id}&${query}`, {
        method: "DELETE",
      })
    const entries = async () =>
      (
        (await (
          await fetch(`${url}/api/agent/extensions?agent=${id}`)
        ).json()) as { state: { scratch?: Array<{ id: string }> } }
      ).state.scratch?.map((entry) => entry.id) ?? []

    assert.deepEqual(await entries(), ["xentry001", "xentry002", "xentry003"])
    const one = await remove("id=xentry002")
    assert.equal(one.status, 200)
    assert.deepEqual(await one.json(), { ok: true, deleted: 1 })
    assert.deepEqual(await entries(), ["xentry001", "xentry003"])
    assert.equal((await remove("id=xentry002")).status, 404)
    assert.equal((await remove("id=../../x")).status, 404)
    assert.equal((await remove("")).status, 400)

    // Archiving (the Delete of the sidebar) keeps the entries.
    const archived = await fetch(`${url}/api/agents/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: [`smith:${id}`] }),
    })
    assert.equal(archived.status, 200)
    assert.equal((await ids(data, conversationId)).length, 2)

    const all = await remove("all=1")
    assert.deepEqual(await all.json(), { ok: true, deleted: 2 })
    assert.deepEqual(await entries(), [])
    assert.ok(!existsSync(join(root, String(conversationId))))
  } finally {
    child.kill("SIGTERM")
    await exited
  }
})
