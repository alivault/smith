import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { AgentMetaDoc, publicId } from "../src/core/agents.ts"
import { tempDir } from "./support.ts"

type HistoryPage = {
  ok: boolean
  offset: number
  end: number
  limit: number
  totalCount: number
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  items: Array<{ kind: string; text?: string }>
}

void test("history pages go back from `before` and forward from `after`", async () => {
  const data = await tempDir("smith-history-test-")
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(data, "smith.sqlite")),
    { models: createModels(), registry: createRegistry() },
    ctx
  )
  const ids: string[] = []
  try {
    for (const count of [7, 0]) {
      const conversation = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { cwd: data },
          init: async (tx, id) => {
            Object.assign(await tx.doc(AgentMetaDoc, id), {
              cwd: data,
              createdAt: Date.now(),
              modifiedAt: Date.now(),
              firstMessage: count ? "Message 0" : "",
              messageCount: count,
            })
            for (let index = 0; index < count; index++) {
              await tx.appendEntry(id, {
                kind: "pi.user",
                model: [
                  {
                    role: "user",
                    content: [{ type: "text", text: `Message ${index}` }],
                    timestamp: Date.now(),
                  },
                ],
              })
            }
          },
        },
        ctx
      )
      ids.push(publicId(conversation.id))
    }
  } finally {
    await harness.close(ctx)
  }
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
    const url = `http://127.0.0.1:${port}`
    const page = async (agent: string, query: string) => {
      const response = await fetch(
        `${url}/api/agent/history?agent=${agent}&${query}`
      )
      assert.equal(response.status, 200, log)
      return (await response.json()) as HistoryPage
    }
    const texts = (history: HistoryPage) =>
      history.items.map((item) => item.text)
    const [long, empty] = ids as [string, string]

    const manifest = (await (
      await fetch(`${url}/api/client/manifest`)
    ).json()) as { capabilities: { features: string[] } }
    assert.ok(
      manifest.capabilities.features.includes("conversation-history-after")
    )

    // Forward from the start.
    const first = await page(long, "after=0&limit=3")
    assert.deepEqual(texts(first), ["Message 0", "Message 1", "Message 2"])
    assert.equal(first.offset, 0)
    assert.equal(first.end, 3)
    assert.equal(first.totalCount, 7)
    assert.equal(first.hasMoreBefore, false)
    assert.equal(first.hasMoreAfter, true)

    // The last page stops at the end.
    const last = await page(long, "after=5&limit=3")
    assert.deepEqual(texts(last), ["Message 5", "Message 6"])
    assert.equal(last.offset, 5)
    assert.equal(last.end, 7)
    assert.equal(last.hasMoreBefore, true)
    assert.equal(last.hasMoreAfter, false)

    // Beyond the end: no items, offset at the end.
    const beyond = await page(long, "after=50&limit=3")
    assert.deepEqual(beyond.items, [])
    assert.equal(beyond.offset, 7)
    assert.equal(beyond.end, 7)
    assert.equal(beyond.hasMoreAfter, false)

    // A negative start is the first item.
    const negative = await page(long, "after=-4&limit=2")
    assert.deepEqual(texts(negative), ["Message 0", "Message 1"])

    // The limit has bounds: at least 1, at most 200.
    assert.equal((await page(long, "after=0&limit=0")).items.length, 1)
    assert.equal((await page(long, "after=0&limit=999")).limit, 200)

    // `before` works as before, and now tells the end too.
    const older = await page(long, "before=4&limit=3")
    assert.deepEqual(texts(older), ["Message 1", "Message 2", "Message 3"])
    assert.equal(older.offset, 1)
    assert.equal(older.end, 4)
    assert.equal(older.hasMoreBefore, true)
    assert.equal(older.hasMoreAfter, true)
    const latest = await page(long, "limit=2")
    assert.deepEqual(texts(latest), ["Message 5", "Message 6"])
    assert.equal(latest.hasMoreAfter, false)

    // An empty conversation.
    const none = await page(empty, "after=0&limit=50")
    assert.deepEqual(none.items, [])
    assert.equal(none.offset, 0)
    assert.equal(none.end, 0)
    assert.equal(none.totalCount, 0)
    assert.equal(none.hasMoreBefore, false)
    assert.equal(none.hasMoreAfter, false)
  } finally {
    child.kill("SIGTERM")
    await exited
  }
})
