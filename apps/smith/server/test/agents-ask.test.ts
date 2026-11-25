/**
 * A chat message that the user sends while an `ask_user` question waits
 * answers the question, with its images, on Smith's real `Agents` class. It
 * is not sent again as a user message.
 */
import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"

import { createRegistry, Harness } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"

import {
  AgentMetaDoc,
  Agents,
  conversationIdOf,
  publicId,
} from "../src/core/agents.ts"
import type { Runtime } from "../src/core/runtime.ts"
import { DEFAULT_SETTINGS } from "../src/core/settings.ts"
import { Viewers } from "../src/core/viewers.ts"
import { EventHub } from "../src/events.ts"
import { createAskExtension } from "../src/extensions/ask.ts"
import {
  ctx,
  lastToolResult,
  scriptedModels,
  tempDir,
  TEST_MODEL,
  type Script,
} from "./support.ts"

// A 1x1 PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="

async function eventually(check: () => boolean, ms = 8000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out")
    await new Promise((done) => setTimeout(done, 25))
  }
}

void test("a chat message answers an open question once, with its images", async () => {
  const dir = await tempDir("smith-ask-test-")
  const script: Script = (messages) =>
    lastToolResult(messages) !== undefined
      ? { text: "Thanks." }
      : {
          tools: [
            {
              name: "ask_user",
              arguments: { question: "Which one?", kind: "text" },
            },
          ],
        }
  const registry = createRegistry()
  registry.install(createAskExtension())
  const { NodeExecutionEnv } =
    await import("@earendil-works/pi-durable/env/node")
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(dir, "smith.sqlite")),
    {
      models: scriptedModels(script),
      registry,
      env: () => new NodeExecutionEnv({ cwd: dir }),
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
          name: "Asker",
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
  const agents = new Agents(
    runtime,
    new EventHub(),
    new Viewers(join(dir, "v"))
  )
  await agents.load()
  try {
    await agents.prompt(id, { message: "Ask me", images: [] })
    await eventually(() => agents.needsInput(id))

    const sent = await agents.prompt(id, {
      message: "This one",
      images: [{ mimeType: "image/png", data: PNG }],
    })
    assert.equal(sent.queued, false)
    const live = (await harness.conversation(conversationIdOf(id), ctx))!
    await live.waitForIdle(ctx)

    const entries = (await live.context(ctx)).entries
    const users = entries.flatMap((entry) =>
      (entry.model ?? []).filter((message) => message.role === "user")
    )
    assert.equal(users.length, 1, "the answer is not sent again")
    const result = entries.find((entry) => entry.kind === "pi.tool-result")
    const content = (
      result!.model![0] as {
        content: Array<{ type: string; text?: string }>
      }
    ).content
    assert.equal(content[0]?.text, "The user answered in chat: This one")
    assert.equal(content.filter((part) => part.type === "image").length, 1)
    await agents.flushMeta()
  } finally {
    await harness.close(ctx)
  }
})
