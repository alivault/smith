import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import type { Api, Model, Tool } from "@earendil-works/pi-ai"

import {
  estimateTokens,
  PromptTokenCounter,
  projectContextChunks,
  type TokenInput,
} from "../src/core/prompt-tokens.ts"
import type { SystemPromptSection } from "../src/core/system-prompt.ts"
import { tempDir } from "./support.ts"

const ANTHROPIC: Model<Api> = {
  id: "claude-test",
  name: "Claude Test",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200_000,
  maxTokens: 8000,
}

const OTHER: Model<Api> = {
  ...ANTHROPIC,
  id: "other",
  api: "openai-completions",
  provider: "other",
  baseUrl: "https://example.com",
}

function section(id: string, text: string): SystemPromptSection {
  return { id, title: id, text, tagged: text.startsWith(`<${id}>`) }
}

const TOOLS: Tool[] = [
  {
    name: "read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "shout",
    description: "Say it loud.",
    parameters: { type: "object", properties: {}, required: [] },
  },
]

function inputOf(
  sections: SystemPromptSection[],
  model: Model<Api> | undefined = ANTHROPIC,
  tools: Tool[] = TOOLS
): TokenInput {
  return {
    model,
    sections,
    text: sections.map((part) => part.text).join("\n\n"),
    tools,
  }
}

/**
 * A fake count_tokens: 10 tokens of request overhead, a token for each 4
 * characters of system text and tool JSON, and 300 for the tool-use prompt.
 */
function fakeApi(status = 200) {
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> =
    []
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as {
      system?: Array<{ text: string }>
      tools?: unknown[]
    }
    requests.push({ headers: new Headers(init?.headers), body })
    if (status !== 200) return new Response("{}", { status })
    let tokens = 10
    for (const block of body.system ?? [])
      tokens += Math.ceil(block.text.length / 4)
    for (const tool of body.tools ?? [])
      tokens += Math.ceil(JSON.stringify(tool).length / 4)
    if (body.tools?.length) tokens += 300
    return Response.json({ input_tokens: tokens })
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

const auth = (apiKey: string | undefined) => ({
  getAuth: () => Promise.resolve(apiKey ? { auth: { apiKey } } : undefined),
})

void test("exact counts subtract the request overhead, and the cache keeps them", async () => {
  const dir = await tempDir("smith-tokens-test-")
  const file = join(dir, "prompt-tokens.json")
  const api = fakeApi()
  const counter = new PromptTokenCounter({
    file,
    models: auth("sk-ant-api-test"),
    fetch: api.fetch,
  })
  const sections = [
    section("preamble", "You are a helpful assistant. ".repeat(8)),
    section("cwd", "<cwd>\n/tmp/project\n</cwd>"),
  ]

  // Without a wait: estimates now, the exact counts in the background.
  const first = await counter.count(inputOf(sections))
  assert.equal(first.method, "exact")
  assert.equal(first.pending, true)
  assert.equal(first.parts.preamble?.exact, false)

  const exact = await counter.count(inputOf(sections), { wait: true })
  assert.equal(exact.pending, false)
  const preamble = sections[0]!.text
  assert.deepEqual(exact.parts.preamble, {
    tokens: Math.ceil(preamble.length / 4),
    exact: true,
  })
  assert.equal(exact.parts.cwd?.tokens, Math.ceil(sections[1]!.text.length / 4))
  // Each tool is counted against the anchor tool: without the tool-use
  // prompt, which is in the overhead of the tools.
  assert.equal(exact.tools.items.length, 2)
  assert.ok(exact.tools.items.every((item) => item.exact))
  assert.equal(exact.tools.overhead?.tokens, 300)
  assert.equal(
    exact.tools.total.tokens,
    exact.tools.items.reduce((total, item) => total + item.tokens, 0) + 300
  )
  assert.equal(
    exact.total.tokens,
    exact.prompt.tokens + exact.tools.total.tokens
  )
  assert.equal(exact.cacheRead, 0.1)
  assert.equal(exact.model?.contextWindow, 200_000)
  // An API key goes in x-api-key.
  assert.equal(api.requests[0]?.headers.get("x-api-key"), "sk-ant-api-test")
  assert.equal(api.requests[0]?.headers.get("authorization"), null)

  // Same text: no new call.
  const calls = counter.calls
  const again = await counter.count(inputOf(sections))
  assert.equal(again.pending, false)
  assert.equal(counter.calls, calls)
  assert.deepEqual(again.parts, exact.parts)

  // A changed part: one new call for it, and one for the whole prompt.
  const changed = [sections[0]!, section("cwd", "<cwd>\n/tmp/other\n</cwd>")]
  const updated = await counter.count(inputOf(changed), { wait: true })
  assert.equal(counter.calls, calls + 2)
  assert.equal(updated.parts.cwd?.exact, true)

  // The cache is in the data folder: a new counter makes no calls.
  counter.save()
  assert.ok(existsSync(file))
  assert.ok(
    Object.keys(
      (JSON.parse(readFileSync(file, "utf8")) as { counts: object }).counts
    ).length > 0
  )
  const fresh = new PromptTokenCounter({
    file,
    models: auth("sk-ant-api-test"),
    fetch: api.fetch,
  })
  const cached = await fresh.count(inputOf(changed))
  assert.equal(fresh.calls, 0)
  assert.equal(cached.pending, false)
  assert.deepEqual(cached.parts, updated.parts)
})

void test("an OAuth token counts with a bearer token and the Claude Code identity", async () => {
  const dir = await tempDir("smith-tokens-test-")
  const api = fakeApi()
  const counter = new PromptTokenCounter({
    file: join(dir, "prompt-tokens.json"),
    models: auth("sk-ant-oat01-test"),
    fetch: api.fetch,
  })
  const sections = [section("preamble", "Hello.")]
  const tokens = await counter.count(inputOf(sections), { wait: true })
  assert.equal(tokens.pending, false)
  const request = api.requests[0]!
  assert.equal(request.headers.get("authorization"), "Bearer sk-ant-oat01-test")
  assert.match(request.headers.get("anthropic-beta") ?? "", /oauth-2025-04-20/)
  // The whole prompt as sent: with the identity block that pi-ai adds.
  const systems = api.requests.map(
    (entry) => (entry.body.system ?? []) as Array<{ text: string }>
  )
  const whole = systems.find((system) => system.length === 2)
  assert.match(whole?.[0]?.text ?? "", /Claude Code/)
  // Tools get their Claude Code names, as in the model request.
  const names = api.requests.flatMap(
    (entry) =>
      (entry.body.tools as Array<{ name: string }> | undefined)?.map(
        (tool) => tool.name
      ) ?? []
  )
  assert.ok(names.includes("Read"))
  assert.deepEqual(
    tokens.tools.items.map((item) => item.name),
    ["read", "shout"]
  )
})

void test("other models, no credentials, and errors fall back to estimates", async () => {
  const dir = await tempDir("smith-tokens-test-")
  const sections = [section("preamble", "x".repeat(70))]

  const api = fakeApi()
  const other = new PromptTokenCounter({
    file: join(dir, "a.json"),
    models: auth("key"),
    fetch: api.fetch,
  })
  const estimated = await other.count(inputOf(sections, OTHER), { wait: true })
  assert.equal(estimated.method, "estimate")
  assert.equal(api.requests.length, 0)
  // pi-ai's estimate: 3.5 characters a token.
  assert.deepEqual(estimated.parts.preamble, { tokens: 20, exact: false })
  assert.deepEqual(estimated, estimateTokens(inputOf(sections, OTHER)))

  const none = new PromptTokenCounter({
    file: join(dir, "b.json"),
    models: auth(undefined),
    fetch: api.fetch,
  })
  const noAuth = await none.count(inputOf(sections), { wait: true })
  assert.equal(noAuth.method, "estimate")
  assert.equal(noAuth.note, "No Anthropic credentials")
  assert.equal(api.requests.length, 0)

  const failing = fakeApi(401)
  const broken = new PromptTokenCounter({
    file: join(dir, "c.json"),
    models: auth("key"),
    fetch: failing.fetch,
  })
  const failed = await broken.count(inputOf(sections), { wait: true })
  assert.equal(failed.pending, false)
  assert.equal(failed.parts.preamble?.exact, false)
  assert.equal(failed.parts.preamble?.tokens, 20)
  assert.match(failed.note ?? "", /HTTP 401/)
  // After an error, no more calls for a while.
  const calls = broken.calls
  await broken.count(inputOf(sections), { wait: true })
  assert.equal(broken.calls, calls)

  const limited = fakeApi(429)
  const busy = new PromptTokenCounter({
    file: join(dir, "d.json"),
    models: auth("key"),
    fetch: limited.fetch,
  })
  const rate = await busy.count(inputOf(sections), { wait: true })
  assert.equal(rate.parts.preamble?.exact, false)
  assert.equal(rate.note, "Rate limited by Anthropic")
})

void test("the project context splits into the global and project files", () => {
  const text = [
    "<project_context>",
    "Project-specific instructions and guidelines:",
    "",
    '<project_instructions path="/home/a/.pi/agent/AGENTS.md">\nGlobal.\n</project_instructions>',
    "",
    '<project_instructions path="/p/AGENTS.md">\nProject.\n</project_instructions>',
    "</project_context>",
  ].join("\n")
  const chunks = projectContextChunks({
    id: "project_context",
    title: "Project context",
    text,
    tagged: true,
    files: [
      { path: "/home/a/.pi/agent/AGENTS.md", scope: "global" },
      { path: "/p/AGENTS.md", scope: "project" },
    ],
  })
  assert.equal(
    chunks?.global,
    '<project_instructions path="/home/a/.pi/agent/AGENTS.md">\nGlobal.\n</project_instructions>'
  )
  assert.equal(
    chunks?.project,
    '<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/p/AGENTS.md">\nProject.\n</project_instructions>\n</project_context>'
  )
})
