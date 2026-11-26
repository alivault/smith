/**
 * Running tool output reaches the clients as small `updateTool` deltas, not
 * as a full `state_sync` for each output step. A tool that starts or ends
 * still sends a full state.
 */
import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"

import Type from "typebox"
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"

import { AgentMetaDoc, Agents, publicId } from "../src/core/agents.ts"
import { applyToolUpdates, type ConversationItem } from "../src/core/items.ts"
import type { Runtime } from "../src/core/runtime.ts"
import { DEFAULT_SETTINGS } from "../src/core/settings.ts"
import { Viewers } from "../src/core/viewers.ts"
import { EventHub, type ServerEvent } from "../src/events.ts"
import { textResult } from "../src/extensions/util.ts"
import {
  ctx,
  lastToolResult,
  scriptedModels,
  tempDir,
  TEST_MODEL,
} from "./support.ts"

type ToolBlock = {
  type: "tool"
  callId?: string
  output: string
  running: boolean
}

function toolBlocks(items: unknown) {
  return (items as ConversationItem[]).flatMap((item) =>
    item.kind === "assistant"
      ? (item.blocks.filter((block) => block.type === "tool") as ToolBlock[])
      : []
  )
}

void test("running tool output is sent as updateTool deltas", async () => {
  const dir = await tempDir("smith-tool-deltas-")
  const steps = 5
  const ticker = defineTool({
    name: "ticker",
    description: "Print lines slowly",
    parameters: Type.Object({}),
    execute: async (_args, api) => {
      for (let index = 1; index <= steps; index += 1) {
        api.output(`line ${index}\n`)
        await new Promise((done) => setTimeout(done, 250))
      }
      return textResult("ticked")
    },
  })
  const registry = createRegistry()
  registry.install(defineExtension({ name: "ticker", tools: [ticker] }))
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(dir, "smith.sqlite")),
    {
      models: scriptedModels((messages) =>
        lastToolResult(messages) !== undefined
          ? { text: "done" }
          : { tools: [{ name: "ticker", arguments: {} }] }
      ),
      registry,
      // As Smith's runtime: store progress at once, so observers see it.
      settings: { progress: { persistWithinMs: 0 } },
    },
    ctx
  )
  const conversation = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: TEST_MODEL, cwd: dir },
      init: async (tx, id) => {
        Object.assign(await tx.doc(AgentMetaDoc, id), {
          cwd: dir,
          name: "Ticker",
          nameSource: "user",
          createdAt: Date.now(),
          modifiedAt: Date.now(),
          firstMessage: "",
          messageCount: 0,
        })
      },
    },
    ctx
  )
  const id = publicId(conversation.id)
  const runtime = {
    harness,
    registry,
    settings: { data: { ...DEFAULT_SETTINGS } },
    resources: { get: async () => ({ skills: [], prompts: [] }) },
    models: { getModel: () => undefined, getAvailableSnapshot: () => [] },
    piSettings: () => ({
      getDefaultThinkingLevel: () => "off",
      getDefaultProvider: () => undefined,
      getDefaultModel: () => undefined,
    }),
  } as unknown as Runtime
  const hub = new EventHub()
  const events: ServerEvent[] = []
  hub.subscribe((event) => {
    if (event.agentId === id) events.push(event)
  })
  const agents = new Agents(runtime, hub, new Viewers(join(dir, "viewers")))
  await agents.load()

  try {
    const stopWatching = agents.watch(id)
    await agents.prompt(id, { message: "tick", images: [] })
    await conversation.waitForIdle(ctx)
    // Let the last flush run.
    await new Promise((done) => setTimeout(done, 50))
    stopWatching()

    const kinds = events.map((event) => event.payload.type)
    const syncs = events.filter((event) => event.payload.type === "state_sync")
    const updates = events.flatMap((event) =>
      event.payload.type === "conversation_delta"
        ? (event.payload.operations as Array<Record<string, unknown>>).filter(
            (operation) => operation.op === "updateTool"
          )
        : []
    )

    // The output steps came as updateTool operations with the full output.
    assert.ok(
      updates.length >= steps - 2,
      `expected updateTool operations, got ${JSON.stringify(kinds)}`
    )
    for (const update of updates) {
      assert.equal(update.running, true)
      assert.match(String(update.output), /^line 1\n/)
    }
    const outputs = updates.map((update) => String(update.output))
    assert.ok(outputs.some((output) => output.includes(`line ${steps - 1}`)))

    // A state_sync showed the tool running, and one showed its result.
    const blocks = syncs.map((event) => toolBlocks(event.payload.items))
    assert.ok(blocks.some((list) => list.some((block) => block.running)))
    const finished = blocks.at(-1)?.find((block) => !block.running)
    assert.equal(finished?.output, "ticked")

    // Few full states: not one for each output step.
    const runningSyncs = blocks.filter((list) =>
      list.some((block) => block.running && block.output)
    )
    assert.ok(
      runningSyncs.length <= 1,
      `state_sync during output: ${runningSyncs.length}`
    )
  } finally {
    await agents.flushMeta()
    await harness.close(ctx)
  }
})

void test("applyToolUpdates updates one tool block and keeps the rest", () => {
  const tool = (callId: string) => ({
    type: "tool" as const,
    blockKey: callId,
    callId,
    output: "",
    isError: false,
    running: true,
  })
  const items: ConversationItem[] = [
    { kind: "user", itemKey: "u", text: "hi", images: [] } as ConversationItem,
    {
      kind: "assistant",
      itemKey: "a",
      blocks: [tool("one"), tool("two")],
      streaming: false,
      done: true,
    },
  ]
  const next = applyToolUpdates(items, [
    { op: "updateTool", callId: "two", output: "out", running: true },
  ])
  assert.equal(next[0], items[0])
  const before = items[1] as Extract<ConversationItem, { kind: "assistant" }>
  const after = next[1] as Extract<ConversationItem, { kind: "assistant" }>
  assert.notEqual(after, before)
  assert.equal(after.blocks[0], before.blocks[0])
  assert.deepEqual(after.blocks[1], { ...tool("two"), output: "out" })
  assert.equal(applyToolUpdates(items, []).length, 2)
})
