/**
 * The `web-access` extension: pi-web-access's web tools as durable tools.
 * `web_search`, and `fetch_content`, which also reads stored content (what
 * pi-web-access's `get_search_content` does). Smith leaves out `source_check`:
 * web_search and fetch_content do the same work.
 *
 * pi-web-access keeps its tool behavior in a host-neutral core, which its own
 * MCP server also uses. Smith drives the same core and its MCP tool schemas.
 * Configuration is pi-web-access's own `~/.pi/web-search.json`.
 */
import Type, { type TSchema } from "typebox"
import {
  defineExtension,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import { getAllowedSearchProviders } from "pi-web-access/gemini-search.ts"
import { MCP_TOOL_DEFINITIONS } from "pi-web-access/mcp-tool-definitions.ts"
import { createStandaloneWebToolCore } from "pi-web-access/web-tool-core.ts"
import type { WebToolResult } from "pi-web-access/web-tool-contract.ts"

import { StringEnum } from "../core/schema.ts"

type Definition = (typeof MCP_TOOL_DEFINITIONS)[number]

type Schema = {
  properties: Record<string, TSchema & { description?: string }>
  required?: string[]
}

let sharedCore: ReturnType<typeof createStandaloneWebToolCore> | undefined

function core() {
  sharedCore ??= createStandaloneWebToolCore()
  return sharedCore
}

/** Say `fetch_content` with `responseId` where pi-web-access says `get_search_content`. */
function retext(text: string) {
  return text
    .replace(
      /retrieval with get_search_content using the returned responseId/g,
      "reading with fetch_content and the returned responseId"
    )
    .replace(
      /, retrievable with get_search_content/g,
      ", readable with fetch_content and the returned responseId"
    )
}

function webTool(
  definition: Definition,
  run: (
    args: Record<string, unknown>,
    signal: AbortSignal
  ) => Promise<WebToolResult>,
  overrides: { description?: string; parameters?: TSchema } = {}
): ToolRegistration {
  return {
    name: definition.name,
    description: overrides.description ?? retext(definition.description),
    parameters:
      overrides.parameters ?? (definition.inputSchema as unknown as TSchema),
    // Searches and fetches have no side effects worth guarding; a rerun after a
    // crash only repeats the request.
    replay: "safe",
    async execute(args, _api, context) {
      const signal = context.abortSignal ?? new AbortController().signal
      const result = await run(args as Record<string, unknown>, signal)
      return {
        // The core names get_search_content; here fetch_content does its work.
        output: result.content.map((part) =>
          part.type === "text"
            ? {
                ...part,
                text: part.text.replace(
                  /\bget_search_content\b/g,
                  "fetch_content"
                ),
              }
            : part
        ),
        details: JSON.parse(JSON.stringify(result.details ?? {})),
        ...(result.isError ? { isError: true } : {}),
      }
    },
  }
}

/**
 * The search providers that `provider` may name: the allowed ones of
 * `~/.pi/web-search.json` (`webSearch.allowedProviders`), else all. Kimi
 * signs in only through Pi, so it is left out, as in pi-web-access's MCP
 * server. Which providers have credentials is known only when a search runs
 * (some checks read browser cookies), so a provider without them returns an
 * error then.
 */
export function searchProviders(): string[] {
  let allowed: readonly string[]
  try {
    allowed = getAllowedSearchProviders()
  } catch {
    allowed = []
  }
  return allowed.filter((provider) => provider !== "kimi")
}

/**
 * `web_search` with a compact `provider`: one enum, not pi-web-access's
 * union of a single provider and a list of providers, which lists each
 * provider twice. A list of providers is rarely needed; `all` searches
 * every provider that has credentials.
 */
function searchTool(search: Definition) {
  const schema = search.inputSchema as unknown as Schema & {
    additionalProperties?: boolean
  }
  const { provider: _provider, ...rest } = schema.properties
  const properties: Record<string, TSchema> = {}
  for (const [name, property] of Object.entries(rest))
    properties[name] = Type.Optional(property)
  properties.provider = Type.Optional(
    StringEnum(["auto", "all", ...searchProviders()], {
      description:
        "Search provider. Default auto: the configured one. all: every provider with credentials.",
    })
  )
  return webTool(
    search,
    (args, signal) => core().webSearch(args as never, signal),
    {
      parameters: Type.Object(properties, { additionalProperties: false }),
    }
  )
}

/**
 * `fetch_content` that also reads stored content: with `responseId` it does
 * what pi-web-access's `get_search_content` does, so the model has one tool
 * for both.
 */
function fetchTool(fetch: Definition, get: Definition | undefined) {
  if (!get)
    return webTool(fetch, (args, signal) =>
      core().fetchContent(args as never, signal)
    )
  const fetchSchema = fetch.inputSchema as unknown as Schema
  const getSchema = get.inputSchema as unknown as Schema
  const properties = { ...fetchSchema.properties }
  for (const [name, schema] of Object.entries(getSchema.properties))
    if (!(name in properties)) properties[name] = schema
  properties.responseId = {
    ...getSchema.properties.responseId!,
    description:
      "Read stored content: the responseId of an earlier web_search or fetch_content. Then url, urlIndex, query, queryIndex select the stored item, and offset, limit, findText, findMode select the part.",
  }
  properties.url = {
    ...fetchSchema.properties.url!,
    description:
      "Single URL to fetch. With responseId: select the stored content of this URL.",
  }
  return webTool(
    fetch,
    (args, signal) =>
      args.responseId
        ? core().getSearchContent(args as never, signal)
        : core().fetchContent(args as never, signal),
    {
      description:
        "Fetch URL(s) and return bounded content. Supports web pages, GitHub repositories, and PDFs. Full content is stored: with the returned responseId, read more pages of it (offset, limit) or find passages (findText). The same works for the results of web_search.",
      // Every property is optional: a call gives url, urls, or responseId.
      // Type.Object marks a property that is not Type.Optional as required.
      parameters: Type.Object(
        Object.fromEntries(
          Object.entries(properties).map(([name, schema]) => [
            name,
            Type.Optional(schema),
          ])
        )
      ),
    }
  )
}

export function createWebAccessExtension(): Extension {
  let enabled: readonly string[]
  try {
    enabled = core().enabledToolNames
  } catch (error) {
    console.warn("[smith] web access is unavailable:", error)
    enabled = []
  }
  const definition = (name: string) =>
    enabled.includes(name)
      ? MCP_TOOL_DEFINITIONS.find((tool) => tool.name === name)
      : undefined
  const search = definition("web_search")
  const fetch = definition("fetch_content")
  const get = definition("get_search_content")
  return defineExtension({
    name: "web-access",
    tools: [
      ...(search ? [searchTool(search)] : []),
      ...(fetch ? [fetchTool(fetch, get)] : []),
    ],
  })
}
