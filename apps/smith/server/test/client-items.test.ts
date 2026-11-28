/**
 * A stream keeps a copy of its client's items, so a `state_sync` after
 * streamed text (and tool output) is a small patch, not all items. End to
 * end: a Smith server with a fake OpenAI-compatible model that streams text,
 * calls a tool, and streams more text.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { test } from "node:test"

import { applyClientDelta, ClientItems } from "../src/core/client-items.ts"
import type { ConversationItem } from "../src/core/items.ts"
import { tempDir } from "./support.ts"

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

const assistant = (
  itemKey: string,
  blocks: Extract<ConversationItem, { kind: "assistant" }>["blocks"],
  streaming = false
): ConversationItem => ({
  kind: "assistant",
  itemKey,
  blocks,
  streaming,
  done: !streaming,
})

void test("applyClientDelta streams text into a new item and keeps the rest", () => {
  const user: ConversationItem = {
    kind: "user",
    itemKey: "u",
    text: "hi",
    images: [],
  }
  const items = [user]
  const first = applyClientDelta(items, [
    {
      op: "appendBlock",
      contentIndex: 0,
      blockKey: "t0",
      blockType: "text",
      delta: "Hel",
    },
  ])
  assert.ok(first)
  assert.equal(first[0], user)
  assert.deepEqual(first[1], {
    kind: "assistant",
    itemKey: "streaming",
    renderKey: "streaming",
    blocks: [{ type: "text", blockKey: "t0", text: "Hel" }],
    streaming: true,
    done: false,
  })
  const second = applyClientDelta(first, [
    {
      op: "appendBlock",
      contentIndex: 0,
      blockKey: "t0",
      blockType: "text",
      delta: "lo",
    },
  ])
  assert.ok(second)
  assert.equal(second.length, 2)
  assert.deepEqual(
    (second[1] as Extract<ConversationItem, { kind: "assistant" }>).blocks,
    [{ type: "text", blockKey: "t0", text: "Hello" }]
  )
  assert.equal(applyClientDelta(items, [{ op: "unknown" }]), undefined)
})

void test("applyClientDelta updates a tool of a committed item", () => {
  const tool = (callId: string) => ({
    type: "tool" as const,
    blockKey: callId,
    callId,
    name: "bash",
    args: {},
    output: "",
    isError: false,
    running: true,
  })
  const items = [
    assistant("a", [tool("one")]),
    assistant("b", [tool("two"), tool("three")]),
  ]
  const next = applyClientDelta(items, [
    { op: "updateTool", callId: "three", output: "out", running: true },
  ])
  assert.ok(next)
  assert.equal(next[0], items[0])
  const blocks = (next[1] as Extract<ConversationItem, { kind: "assistant" }>)
    .blocks
  assert.equal(
    blocks[0],
    (items[1] as Extract<ConversationItem, { kind: "assistant" }>).blocks[0]
  )
  assert.deepEqual(blocks[1], { ...tool("three"), output: "out" })
})

void test("ClientItems sends all items first, then patches", () => {
  const user: ConversationItem = {
    kind: "user",
    itemKey: "u",
    text: "hi",
    images: [],
  }
  const clientItems = new ClientItems()
  const full = clientItems.sync({
    type: "state_sync",
    agentId: "s1",
    items: [user],
  })
  assert.ok(Array.isArray(full.items))
  clientItems.delta([
    {
      op: "appendBlock",
      contentIndex: 0,
      blockKey: "t0",
      blockType: "text",
      delta: "Hello",
    },
  ])
  const streamingItem = {
    ...assistant(
      "streaming",
      [{ type: "text", blockKey: "t0", text: "Hello" }],
      true
    ),
    renderKey: "streaming",
  }
  const committed = assistant("message:1", [
    { type: "text", blockKey: "t0", text: "Hello!" },
  ])
  // The client has the streaming item: only the committed item replaces it.
  const patched = clientItems.sync({
    type: "state_sync",
    agentId: "s1",
    items: [user, committed],
  })
  assert.equal(patched.items, undefined)
  assert.deepEqual(patched.itemsPatch, {
    previousLength: 2,
    start: 1,
    deleteCount: 1,
    items: [committed],
  })
  // Unchanged items after the streamed text: an empty patch.
  clientItems.delta([{ op: "replaceItem", item: streamingItem as never }])
  const same = clientItems.sync({
    type: "state_sync",
    agentId: "s1",
    items: [user, committed, streamingItem],
  })
  assert.deepEqual(same.itemsPatch, {
    previousLength: 3,
    start: 3,
    deleteCount: 0,
    items: [],
  })
  // An unknown operation: the next sync sends all items.
  clientItems.delta([{ op: "somethingNew" }])
  const again = clientItems.sync({
    type: "state_sync",
    agentId: "s1",
    items: [user, committed],
  })
  assert.ok(Array.isArray(again.items))
})

// -----------------------------------------------------------------------------
// End to end

function lastUserText(body: {
  messages?: Array<{ role: string; content: unknown }>
}) {
  const user = [...(body.messages ?? [])]
    .reverse()
    .find((message) => message.role === "user")
  if (!user) return ""
  if (typeof user.content === "string") return user.content
  return (user.content as Array<{ text?: string }>)
    .map((part) => part.text ?? "")
    .join("")
}

/**
 * A model that streams text for a STREAM message: text, a bash call, and
 * after the result more text. Other messages get "ok".
 */
async function fakeModel(): Promise<Server> {
  const server = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", () => {
      void (async () => {
        const body = JSON.parse(raw || "{}") as {
          messages?: Array<{ role: string; content: unknown }>
          tools?: unknown[]
        }
        const send = (delta: Record<string, unknown>, finish?: string) =>
          response.write(
            `data: ${JSON.stringify({
              id: "c1",
              object: "chat.completion.chunk",
              created: 1,
              model: "fake",
              choices: [{ index: 0, delta, finish_reason: finish ?? null }],
            })}\n\n`
          )
        response.writeHead(200, { "content-type": "text/event-stream" })
        const messages = body.messages ?? []
        const afterUser = messages.slice(
          messages.findLastIndex((message) => message.role === "user") + 1
        )
        const toolResults = afterUser.filter((m) => m.role === "tool").length
        if (!body.tools?.length || !lastUserText(body).includes("STREAM")) {
          send({ role: "assistant", content: "ok" })
          send({}, "stop")
        } else {
          send({ role: "assistant", content: "" })
          send({ reasoning_content: "I think. " })
          for (let index = 0; index < 12; index += 1) {
            send({ content: `word${index} ` })
            await sleep(40)
          }
          if (toolResults === 0) {
            send({
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({
                      command:
                        "for i in 1 2 3; do echo line $i; sleep 0.2; done",
                    }),
                  },
                },
              ],
            })
            send({}, "tool_calls")
          } else {
            send({}, "stop")
          }
        }
        response.end("data: [DONE]\n\n")
      })()
    })
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  return server
}

async function startSmith(data: string, modelPort: number) {
  const agentDir = join(data, "agent")
  await mkdir(agentDir, { recursive: true })
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          api: "openai-completions",
          apiKey: "test",
          models: [
            {
              id: "fake",
              name: "Fake",
              reasoning: true,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    })
  )
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "fake", defaultModel: "fake" })
  )
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir }
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
    { env, stdio: ["ignore", "pipe", "pipe"] }
  )
  let log = ""
  child.stdout.on("data", (chunk) => (log += chunk.toString()))
  child.stderr.on("data", (chunk) => (log += chunk.toString()))
  const exited = new Promise<void>((done) => child.once("exit", () => done()))
  let port: number | undefined
  for (let i = 0; i < 150 && !port; i++) {
    try {
      port = JSON.parse(await readFile(join(data, "server.json"), "utf8")).port
    } catch {
      if (child.exitCode !== null) throw new Error(log)
      await sleep(100)
    }
  }
  assert.ok(port, log)
  const cli = (args: string[]) =>
    new Promise<string>((done, reject) => {
      const proc = spawn(
        process.execPath,
        ["dist/smith-server.mjs", "agent", ...args, "--data-dir", data],
        { env, stdio: ["ignore", "pipe", "pipe"] }
      )
      let stdout = ""
      let stderr = ""
      proc.stdout.on("data", (chunk) => (stdout += chunk.toString()))
      proc.stderr.on("data", (chunk) => (stderr += chunk.toString()))
      proc.once("exit", (code) =>
        code === 0 ? done(stdout) : reject(new Error(`${stderr}\n${log}`))
      )
    })
  return {
    url: `http://127.0.0.1:${port}`,
    cli,
    async stop() {
      child.kill("SIGTERM")
      await exited
    },
  }
}

type Payload = Record<string, unknown> & { type?: string }

/** Read the SSE of `url`; `onEvent` returns true to stop. */
async function readEvents(
  url: string,
  onEvent: (payload: Payload) => boolean | void
) {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal })
  assert.ok(response.body)
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true })
      let end
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data && onEvent(JSON.parse(data) as Payload)) return
      }
    }
  } finally {
    controller.abort()
  }
}

/** Apply an items patch as the web client does. */
function applyPatch(items: unknown[], patch: Record<string, unknown>) {
  const start = patch.start as number
  const deleteCount = patch.deleteCount as number
  assert.equal(patch.previousLength, items.length, "the patch fits")
  return [
    ...items.slice(0, start),
    ...(patch.items as unknown[]),
    ...items.slice(start + deleteCount),
  ]
}

void test("a state sync after streamed text is a patch, and the client items match a full sync", async () => {
  const data = await tempDir("smith-client-items-")
  const project = await tempDir("smith-client-items-project-")
  const model = await fakeModel()
  const smith = await startSmith(data, (model.address() as AddressInfo).port)
  try {
    const started = JSON.parse(
      await smith.cli(["start", project, "hello", "--json"])
    ) as { id: string }
    await smith.cli(["wait", started.id, "--timeout", "60"])
    const eventsUrl = `${smith.url}/events?context=test&agent=${started.id}`

    let items: unknown[] | undefined
    const syncs: Payload[] = []
    let deltas = 0
    let prompted = false
    let done = false
    await readEvents(eventsUrl, (payload) => {
      if (payload.type === "state_sync") {
        if (Array.isArray(payload.items)) items = payload.items as unknown[]
        else if (payload.itemsPatch && items)
          items = applyPatch(items, payload.itemsPatch as Payload)
        if (items && !prompted) {
          prompted = true
          void smith.cli(["send", started.id, "STREAM please"])
        } else syncs.push(payload)
        // The end of the turn: the agent is idle and the last item is done.
        if (done && payload.streaming === false) return true
      }
      if (payload.type === "conversation_delta" && items) {
        deltas += 1
        const next = applyClientDelta(
          items as ConversationItem[],
          payload.operations as never
        )
        assert.ok(next, "known operations")
        items = next
      }
      if (payload.type === "agent_done") done = true
      return false
    })

    assert.ok(deltas > 3, `streamed deltas: ${deltas}`)
    assert.ok(syncs.length >= 2, `state syncs: ${syncs.length}`)
    const full = syncs.filter((sync) => Array.isArray(sync.items))
    assert.deepEqual(
      full.map((sync) => (sync.items as unknown[]).length),
      [],
      "no state sync after the bootstrap sends all items"
    )

    // A new stream's bootstrap has all items: the client got the same.
    let fresh: unknown[] | undefined
    await readEvents(eventsUrl, (payload) => {
      if (payload.type === "state_sync" && Array.isArray(payload.items)) {
        fresh = payload.items as unknown[]
        return true
      }
      return false
    })
    assert.deepEqual(items, fresh)
  } finally {
    await smith.stop()
    model.close()
  }
})
