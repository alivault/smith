/**
 * Deferred tools: requests do not offer them until the model loads them
 * with `load_tools` (or calls one); a loaded tool stays offered, also after
 * a restart; agents from before keep the deferred tools that they used; a
 * profile can load tools at once; a removed tool cannot be loaded.
 */
import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"

import { getCurrentTools, type Message } from "@earendil-works/pi-ai"
import {
  createRegistry,
  defineExtension,
  defineTool,
  type Extension,
} from "@earendil-works/pi-durable"
import Type from "typebox"

import { applyProfile, findProfile } from "../src/core/profiles.ts"
import {
  deferredParts,
  deferredSectionText,
  deferTools,
  loadUsedDeferredTools,
  planLoad,
  usedDeferredTools,
} from "../src/extensions/deferred.ts"
import { textResult } from "../src/extensions/util.ts"
import {
  ctx,
  openHarness,
  tempDir,
  TEST_MODEL,
  type Script,
} from "./support.ts"

function fakeTool(name: string, description: string) {
  return defineTool({
    name,
    description,
    parameters: Type.Object({ value: Type.Optional(Type.String()) }),
    replay: "safe",
    async execute(args) {
      return textResult(`${name} ran with ${args.value ?? "nothing"}`)
    },
  })
}

/** Fake tools: `browser` and `watch` deferred, `echo` not. */
function fakeExtensions(defer = true): Extension[] {
  const tools = defineExtension({
    name: "fake",
    tools: [
      fakeTool("echo", "Echo a value."),
      fakeTool("browser", "Your browser. It opens pages."),
      fakeTool("watch", "Wait for a condition."),
      fakeTool("web_search", "Search the web."),
    ],
  })
  return [
    defineExtension({ name: "smith", ...deferredParts }),
    defer ? deferTools(tools) : tools,
  ]
}

/** The newest tool result of a request. */
function lastResult(messages: readonly Message[]) {
  return messages.findLast((message) => message.role === "toolResult")
}

/** The tools that each request offered, by name. */
function recorder() {
  const requests: Array<{ tools: string[]; messages: readonly Message[] }> = []
  const record = (messages: readonly Message[]) =>
    requests.push({
      tools: getCurrentTools(messages).map((tool) => tool.name),
      messages,
    })
  return { requests, record }
}

void test("deferred tools load with load_tools and stay loaded after a restart", async () => {
  const dir = await tempDir()
  const database = join(dir, "db.sqlite")
  const { requests, record } = recorder()
  let step = 0
  const script: Script = (messages) => {
    record(messages)
    step += 1
    if (step === 1)
      return {
        tools: [
          { name: "load_tools", arguments: { names: ["browser", "nope"] } },
        ],
      }
    if (step === 2)
      return { tools: [{ name: "browser", arguments: { value: "x" } }] }
    if (step === 3) return { text: "done" }
    return { text: "again" }
  }
  let harness = await openHarness(database, fakeExtensions(), script)
  let id
  try {
    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: TEST_MODEL } },
      ctx
    )
    id = conversation.id
    await (
      await conversation.submit({ type: "input", content: "go" }, ctx)
    ).wait(ctx)
    // Not offered at first, but listed in the section.
    assert.deepEqual(requests[0]!.tools.sort(), ["echo", "load_tools"])
    const system = JSON.stringify(
      requests[0]!.messages.filter((message) => message.role === "system")
    )
    assert.match(system, /deferred_tools/)
    assert.match(system, /- browser: your own browser/)
    assert.match(system, /- watch: wait in the background/)
    // The next request offers the loaded tool, and only it.
    assert.deepEqual(requests[1]!.tools.sort(), [
      "browser",
      "echo",
      "load_tools",
    ])
    const loadResult = lastResult(requests[1]!.messages)
    assert.match(JSON.stringify(loadResult), /Loaded: browser\./)
    assert.match(JSON.stringify(loadResult), /Not available to you: nope\./)
    assert.match(
      JSON.stringify(lastResult(requests[2]!.messages)),
      /browser ran/
    )
    // Loading changes no section: the section lists loaded tools too.
    const sectionUpdates = requests[2]!.messages.filter(
      (message) =>
        message.role === "system" &&
        message.sections !== undefined &&
        "deferred_tools" in message.sections
    )
    assert.equal(sectionUpdates.length, 1)
  } finally {
    await harness.close(ctx)
  }

  // After a restart, the loaded tool is still offered.
  harness = await openHarness(database, fakeExtensions(), script)
  try {
    const conversation = await harness.conversation(id, ctx)
    assert.ok(conversation)
    await (
      await conversation.submit({ type: "input", content: "again" }, ctx)
    ).wait(ctx)
    assert.deepEqual(requests.at(-1)!.tools.sort(), [
      "browser",
      "echo",
      "load_tools",
    ])
    const agent = await conversation.agent(ctx)
    assert.deepEqual(
      agent.deferred.map((tool) => tool.name),
      ["watch", "web_search"]
    )
  } finally {
    await harness.close(ctx)
  }
})

void test("a call to a deferred tool that is not loaded loads it", async () => {
  const dir = await tempDir()
  const { requests, record } = recorder()
  let step = 0
  const script: Script = (messages) => {
    record(messages)
    step += 1
    if (step <= 2)
      return { tools: [{ name: "watch", arguments: { value: "y" } }] }
    return { text: "done" }
  }
  const harness = await openHarness(
    join(dir, "db.sqlite"),
    fakeExtensions(),
    script
  )
  try {
    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: TEST_MODEL } },
      ctx
    )
    await (
      await conversation.submit({ type: "input", content: "go" }, ctx)
    ).wait(ctx)
    assert.ok(!requests[0]!.tools.includes("watch"))
    const first = JSON.stringify(lastResult(requests[1]!.messages))
    assert.match(first, /watch was not loaded, so this call did not run/)
    assert.ok(requests[1]!.tools.includes("watch"))
    assert.match(JSON.stringify(lastResult(requests[2]!.messages)), /watch ran/)
  } finally {
    await harness.close(ctx)
  }
})

void test("an agent from before deferred tools keeps the ones it used", async () => {
  const dir = await tempDir()
  const database = join(dir, "db.sqlite")
  const { requests, record } = recorder()
  let step = 0
  const script: Script = (messages) => {
    record(messages)
    step += 1
    if (step === 1)
      return { tools: [{ name: "browser", arguments: { value: "a" } }] }
    return { text: "done" }
  }
  // Before: nothing is deferred, and the model uses browser.
  let harness = await openHarness(database, fakeExtensions(false), script)
  let id
  try {
    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: TEST_MODEL } },
      ctx
    )
    id = conversation.id
    await (
      await conversation.submit({ type: "input", content: "go" }, ctx)
    ).wait(ctx)
  } finally {
    await harness.close(ctx)
  }
  // After: browser and watch are deferred; browser stays loaded.
  harness = await openHarness(database, fakeExtensions(), script)
  try {
    const conversation = await harness.conversation(id, ctx)
    assert.ok(conversation)
    assert.deepEqual(await loadUsedDeferredTools(conversation, ctx), [
      "browser",
    ])
    assert.deepEqual(await loadUsedDeferredTools(conversation, ctx), [])
    await (
      await conversation.submit({ type: "input", content: "next" }, ctx)
    ).wait(ctx)
    const offered = requests.at(-1)!.tools
    assert.ok(offered.includes("browser"))
    assert.ok(!offered.includes("watch"))
  } finally {
    await harness.close(ctx)
  }
})

void test("profiles load deferred tools, and removed tools cannot load", async () => {
  const dir = await tempDir()
  const extensions = fakeExtensions()
  const registry = createRegistry()
  for (const extension of extensions) registry.install(extension)
  const harness = await openHarness(join(dir, "db.sqlite"), extensions, () => ({
    text: "ok",
  }))
  try {
    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: TEST_MODEL } },
      ctx
    )
    // A custom profile loads web_search at once, and takes browser away.
    await applyProfile(
      conversation,
      registry,
      {
        name: "custom",
        description: "custom",
        loadTools: ["web_search"],
        removeTools: ["browser"],
      },
      ctx
    )
    let agent = await conversation.agent(ctx)
    assert.ok(agent.tools.some((tool) => tool.name === "web_search"))
    assert.deepEqual(
      agent.deferred.map((tool) => tool.name),
      ["watch"]
    )
    // browser is removed: load_tools does not load it.
    assert.deepEqual(planLoad(agent, ["browser", "watch", "web_search"]), {
      load: ["watch"],
      loaded: ["web_search"],
      unknown: ["browser"],
    })
    assert.doesNotMatch(deferredSectionText(agent) ?? "", /browser/)
    // A profile without loadTools keeps the loaded tools.
    await applyProfile(conversation, registry, undefined, ctx)
    agent = await conversation.agent(ctx)
    assert.ok(agent.tools.some((tool) => tool.name === "web_search"))
    assert.ok(agent.deferred.some((tool) => tool.name === "browser"))
    // The researcher profile loads the web tools.
    assert.deepEqual(findProfile("researcher")?.loadTools, [
      "web_search",
      "fetch_content",
    ])
  } finally {
    await harness.close(ctx)
  }
})

void test("usedDeferredTools finds model calls of deferred tools", () => {
  const deferred = [{ name: "browser" }, { name: "watch" }] as never
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "1", name: "browser", arguments: {} },
        { type: "toolCall", id: "2", name: "echo", arguments: {} },
      ],
    },
  ] as unknown as Message[]
  assert.deepEqual(usedDeferredTools(messages, { deferred }), ["browser"])
  assert.deepEqual(usedDeferredTools(messages, { deferred: [] }), [])
})
