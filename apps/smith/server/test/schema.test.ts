/**
 * Compact tool schemas: `StringEnum` renders one `enum`, the validator
 * accepts and rejects the same values as for a union of literals, and no
 * Smith tool sends a union of string literals. `web_search` lists its
 * providers once.
 */
import assert from "node:assert/strict"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"

import { validateToolArguments } from "@earendil-works/pi-ai"
import type { ToolRegistration } from "@earendil-works/pi-durable"
import * as esbuild from "esbuild"
import Type, { type TSchema } from "typebox"

import { createSmithCodingTools } from "../src/core/coding-tools.ts"
import { StringEnum } from "../src/core/schema.ts"
import { HostBridge } from "../src/extensions/host.ts"
import { createSmithExtensions } from "../src/extensions/index.ts"
import { tempDir } from "./support.ts"

function validate(parameters: TSchema, args: unknown) {
  const tool = { name: "t", description: "", parameters }
  try {
    return {
      ok: true,
      value: validateToolArguments(tool, {
        type: "toolCall",
        id: "1",
        name: "t",
        arguments: args as never,
      }),
    }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/** Paths of schemas that are a union of string constants. */
function literalUnions(schema: unknown, path = ""): string[] {
  if (!schema || typeof schema !== "object") return []
  const found: string[] = []
  const record = schema as Record<string, unknown>
  const anyOf = record.anyOf
  if (
    Array.isArray(anyOf) &&
    anyOf.length > 0 &&
    anyOf.every(
      (item) => item && typeof item === "object" && "const" in (item as object)
    )
  )
    found.push(path || "/")
  for (const [key, value] of Object.entries(record))
    found.push(...literalUnions(value, `${path}/${key}`))
  return found
}

void test("StringEnum renders one enum and validates like a union of literals", () => {
  const values = ["create", "list", "cancel"] as const
  const compact = Type.Object({
    action: StringEnum(values, { description: "What to do" }),
    mode: Type.Optional(StringEnum(["a", "b"])),
  })
  const union = Type.Object({
    action: Type.Union(values.map((value) => Type.Literal(value))),
    mode: Type.Optional(Type.Union([Type.Literal("a"), Type.Literal("b")])),
  })
  assert.deepEqual(JSON.parse(JSON.stringify(compact.properties.action)), {
    description: "What to do",
    type: "string",
    enum: ["create", "list", "cancel"],
  })
  assert.ok(
    JSON.stringify(compact.properties.mode).length <
      JSON.stringify(union.properties.mode).length / 2
  )
  const cases: unknown[] = [
    { action: "create" },
    { action: "list", mode: "b" },
    { action: "remove" },
    { action: "list", mode: "c" },
    { action: 1 },
    {},
    { mode: "a" },
    { action: null },
  ]
  for (const args of cases) {
    const left = validate(compact, args)
    const right = validate(union, args)
    assert.equal(left.ok, right.ok, JSON.stringify(args))
    if (left.ok) assert.deepEqual(left.value, right.value)
  }
  assert.equal(validate(compact, { action: "create" }).ok, true)
  assert.equal(validate(compact, { action: "remove" }).ok, false)
})

void test("Smith tools have no unions of string literals", async () => {
  const dataDir = await tempDir()
  const host = new HostBridge()
  const { extensions } = createSmithExtensions({ host, dataDir })
  const tools: ToolRegistration[] = [
    ...(createSmithCodingTools({ host, shellPrefix: () => undefined }).tools ??
      []),
    ...extensions.flatMap((extension) => extension.tools ?? []),
  ]
  const names = tools.map((tool) => tool.name)
  for (const name of [
    "todo",
    "watch",
    "schedule",
    "ask_user",
    "browser",
    "agents",
    "terminal",
  ])
    assert.ok(names.includes(name), name)
  for (const tool of tools)
    assert.deepEqual(literalUnions(tool.parameters), [], tool.name)
  // The enum still rejects unknown actions.
  const todo = tools.find((tool) => tool.name === "todo")!
  assert.equal(validate(todo.parameters, { op: "set", items: [] }).ok, true)
  assert.equal(validate(todo.parameters, { op: "drop" }).ok, false)
})

void test("web_search lists its providers once, as one enum", async () => {
  // pi-web-access ships TypeScript in node_modules, which Node does not
  // strip: bundle the extension as the server build does.
  // In dist, so its imports resolve from the server's node_modules.
  const root = join(import.meta.dirname, "..")
  const outfile = join(root, "dist", `web-access-test-${process.pid}.mjs`)
  const pkg = (await import("../package.json", { with: { type: "json" } }))
    .default as { dependencies: Record<string, string> }
  const external = Object.keys(pkg.dependencies).filter(
    (name) => name !== "pi-web-access"
  )
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ["src/extensions/web-access.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "error",
    external: [...external, ...external.map((name) => `${name}/*`)],
    banner: {
      js: 'import { createRequire as __r } from "node:module"; const require = __r(import.meta.url);',
    },
  })
  const loaded = import(pathToFileURL(outfile).href).finally(() =>
    rmSync(outfile, { force: true })
  )
  const module = (await loaded) as {
    createWebAccessExtension: () => { tools?: ToolRegistration[] }
    searchProviders: () => string[]
  }
  const tools = module.createWebAccessExtension().tools ?? []
  const search = tools.find((tool) => tool.name === "web_search")
  if (!search) return // web access is off in this environment
  assert.deepEqual(literalUnions(search.parameters), [])
  const provider = (
    search.parameters as unknown as {
      properties: Record<string, { type?: string; enum?: string[] }>
    }
  ).properties.provider!
  assert.equal(provider.type, "string")
  const providers = module.searchProviders()
  assert.deepEqual(provider.enum, ["auto", "all", ...providers])
  assert.ok(!providers.includes("kimi"))
  // Each provider name appears once in the whole schema.
  const text = JSON.stringify(search.parameters)
  for (const name of providers.slice(0, 5))
    assert.equal(text.split(`"${name}"`).length - 1, 1, name)
  assert.equal(validate(search.parameters, { query: "x" }).ok, true)
  assert.equal(
    validate(search.parameters, { query: "x", provider: providers[0] }).ok,
    true
  )
  assert.equal(
    validate(search.parameters, { query: "x", provider: "nope" }).ok,
    false
  )
  assert.equal(validate(search.parameters, { query: "x", foo: 1 }).ok, false)
})
