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
import type { TSchema } from "typebox"
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
 * An object schema whose properties are all optional, as plain JSON Schema.
 * pi-web-access's properties carry TypeBox's `~optional` marker as a plain
 * key, which pi-ai would send to the model with each property.
 */
function optionalObject(
  properties: Record<string, TSchema>,
  options: { additionalProperties?: boolean } = {}
): TSchema {
  const plain: Record<string, unknown> = {}
  for (const [name, schema] of Object.entries(properties)) {
    const { "~optional": _optional, ...rest } = schema as Record<
      string,
      unknown
    >
    plain[name] = rest
  }
  return { type: "object", properties: plain, ...options } as TSchema
}

/** Shorter descriptions of `web_search` parameters. */
const SEARCH_DESCRIPTIONS: Record<string, string> = {
  query: "One query",
  queries: "Several queries, searched in parallel",
  numResults: "Results per query (default 5)",
  includeContent: "Also fetch the full pages; read them with fetch_content",
  domainFilter: "Only these domains; prefix - to exclude",
  category: "Exa only, e.g. news, research paper",
  proxy: "Proxy URL for this call; empty: direct",
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
    properties[name] = {
      ...property,
      ...(SEARCH_DESCRIPTIONS[name]
        ? { description: SEARCH_DESCRIPTIONS[name] }
        : {}),
    }
  properties.provider = StringEnum(["auto", "all", ...searchProviders()], {
    description:
      "Default auto: the configured provider. all: every provider with credentials.",
  })
  return webTool(
    search,
    (args, signal) => core().webSearch(args as never, signal),
    {
      description:
        "Search the web. Returns source-linked results or provider answers, and a responseId: read the full results with fetch_content.",
      parameters: optionalObject(properties, { additionalProperties: false }),
    }
  )
}

/** Shorter descriptions of `fetch_content` parameters. */
const FETCH_DESCRIPTIONS: Record<string, string> = {
  urls: "Several URLs, fetched in parallel",
  mode: "readable (default): markdown; raw: the exact body",
  forceClone: "Clone a GitHub repository also when it is large",
  proxy: "Proxy URL for this call; empty: direct",
  query: "Stored results of this query",
  queryIndex: "Stored results of the query at this index",
  urlIndex: "Stored content of the URL at this index",
  offset: "Character offset (default 0)",
  limit: "Characters to return",
  findText: "Text or texts to find",
  findMode: "exact, case-insensitive (default), or fuzzy",
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
      "Read stored content of an earlier web_search or fetch_content. Select it with url, urlIndex, query, queryIndex; select the part with offset, limit, findText, findMode.",
  }
  properties.url = {
    ...fetchSchema.properties.url!,
    description: "URL to fetch; with responseId: the stored URL",
  }
  for (const [name, description] of Object.entries(FETCH_DESCRIPTIONS))
    if (properties[name])
      properties[name] = { ...properties[name], description }
  return webTool(
    fetch,
    (args, signal) =>
      args.responseId
        ? core().getSearchContent(args as never, signal)
        : core().fetchContent(args as never, signal),
    {
      description:
        "Fetch URLs (web pages, GitHub repositories, PDFs) and return bounded content. The full content is stored under a responseId: read more of it (offset, limit) or find passages (findText). This also reads web_search results.",
      // Every property is optional: a call gives url, urls, or responseId.
      parameters: optionalObject(properties),
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
