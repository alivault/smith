/**
 * Token counts of an agent's system prompt and tool definitions.
 *
 * For an Anthropic model with credentials, the counts are exact: Anthropic's
 * free `POST /v1/messages/count_tokens` counts the system blocks and tools as
 * pi-ai builds them for the model request. pi-ai builds the request body,
 * and `onPayload` stops it before it is sent, so the counted text and tool
 * schemas are the real ones (with the OAuth identity block and tool names).
 *
 * The API counts a whole request, so each part is counted alone and the
 * fixed overhead of a minimal request is subtracted. A tool is counted as
 * the difference that it makes to a request with one small anchor tool:
 * the hidden tool-use prompt that any tools add is then not in each tool.
 *
 * Each count is cached by model and the SHA-256 of the exact request, in
 * memory and in a small JSON file, so the API sees a part again only when
 * its text changes. Other models, and errors, get pi-ai's estimate.
 */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import {
  normalizeContext,
  type Api,
  type Model,
  type ModelAuth,
  type Tool,
} from "@earendil-works/pi-ai"
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages"
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate"

import { scopeText, type SystemPromptSection } from "./system-prompt.ts"

export type TokenCount = { tokens: number; exact: boolean }

export type PromptTokens = {
  /** How the counts are made for this model. */
  method: "exact" | "estimate"
  /** Some exact counts are still missing; `wait` gets them. */
  pending: boolean
  /** Why the counts are estimates, when the model could count exactly. */
  note?: string
  model?: { provider: string; id: string; contextWindow?: number }
  /** Cache read price as a fraction of the input price. */
  cacheRead?: number
  /** By section id, and `project_context:global` and `:project`. */
  parts: Record<string, TokenCount>
  /** The whole system prompt as the request sends it. */
  prompt: TokenCount
  tools: {
    total: TokenCount
    /** Tokens that the tools add beyond their definitions. */
    overhead?: TokenCount
    items: Array<{ name: string } & TokenCount>
  }
  total: TokenCount
}

export type TokenInput = {
  model: Model<Api> | undefined
  sections: readonly SystemPromptSection[]
  /** The full system prompt text. */
  text: string
  /** The tools that the request offers. */
  tools: readonly Tool[]
}

type Auth = {
  getAuth(model: Model<Api>): Promise<{ auth: ModelAuth } | undefined>
}

type Body = { system?: unknown[]; tools?: unknown[] }

type Unit = { key: string; body: Body }

/** A small tool: counts of other tools are relative to it. */
const ANCHOR_TOOL = {
  name: "anchor",
  description: "Anchor.",
  input_schema: { type: "object", properties: {}, required: [] },
}

const PLACEHOLDER_PREFIX = "__pi_"
const COUNT_URL = "https://api.anthropic.com/v1/messages/count_tokens"
const MESSAGES = [{ role: "user", content: "x" }]
const MAX_ENTRIES = 5000
const CONCURRENCY = 2
const CALL_TIMEOUT_MS = 5000
const WAIT_TIMEOUT_MS = 30_000
/** After an error that is not a rate limit: estimates for a while. */
const FAILURE_PAUSE_MS = 10 * 60_000

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function estimate(tokens: number): TokenCount {
  return { tokens, exact: false }
}

function sum(counts: readonly TokenCount[]): TokenCount {
  return {
    tokens: counts.reduce((total, count) => total + count.tokens, 0),
    exact: counts.every((count) => count.exact),
  }
}

/** Remove `cache_control`: it does not change the count. */
function withoutCacheControl(blocks: readonly unknown[]) {
  return blocks.map((block) => {
    if (!block || typeof block !== "object") return block
    const { cache_control: _, ...rest } = block as Record<string, unknown>
    return rest
  })
}

/** The texts to count: each section, and the project context split. */
function partTexts(sections: readonly SystemPromptSection[]) {
  const texts: Array<[string, string]> = []
  for (const section of sections) {
    texts.push([section.id, section.text])
    // The global and the project rows: the blocks of their own files.
    if (section.id !== "project_context" || !section.files?.length) continue
    for (const scope of ["global", "project"] as const) {
      const text = scopeText(section, scope)
      if (text) texts.push([`project_context:${scope}`, text])
    }
  }
  return texts
}

function cacheReadOf(model: Model<Api> | undefined) {
  const cost = model?.cost
  if (!cost || !(cost.input > 0) || !(cost.cacheRead > 0)) return undefined
  return Math.round((cost.cacheRead / cost.input) * 10_000) / 10_000
}

/** The counts by pi-ai's estimate: about 3.5 characters a token. */
export function estimateTokens(input: TokenInput): PromptTokens {
  const parts: Record<string, TokenCount> = {}
  for (const [key, text] of partTexts(input.sections))
    parts[key] = estimate(estimateTextTokens(text))
  const items = input.tools.map((tool) => ({
    name: tool.name,
    ...estimate(
      estimateTextTokens(
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })
      )
    ),
  }))
  const prompt = estimate(estimateTextTokens(input.text))
  const tools = sum(items)
  const { model } = input
  const cacheRead = cacheReadOf(model)
  return {
    method: "estimate",
    pending: false,
    ...(model
      ? {
          model: {
            provider: model.provider,
            id: model.id,
            ...(model.contextWindow
              ? { contextWindow: model.contextWindow }
              : {}),
          },
        }
      : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    parts,
    prompt,
    tools: { total: tools, items },
    total: sum([prompt, tools]),
  }
}

/** Whether count_tokens can count for the model. */
export function canCountExactly(model: Model<Api> | undefined) {
  return (
    model !== undefined &&
    model.api === "anthropic-messages" &&
    model.provider === "anthropic" &&
    /^https:\/\/api\.anthropic\.com\/?$/.test(model.baseUrl)
  )
}

/**
 * The system blocks, tools, and betas of the model request, as pi-ai
 * builds them. The request stops in `onPayload`, before it is sent.
 */
export async function anthropicPayload(
  model: Model<Api>,
  auth: ModelAuth,
  input: Pick<TokenInput, "text" | "tools">
) {
  let payload: Record<string, unknown> | undefined
  const stop = new Error("payload captured")
  const events = anthropicStream(
    model as Model<"anthropic-messages">,
    normalizeContext({
      messages: [
        {
          role: "system",
          content: input.text,
          ...(input.tools.length > 0 ? { toolsAdded: [...input.tools] } : {}),
          timestamp: 0,
        },
        { role: "user", content: "x", timestamp: 0 },
      ],
    }),
    {
      ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
      ...(auth.headers ? { headers: auth.headers } : {}),
      onPayload: (params) => {
        payload = params as Record<string, unknown>
        throw stop
      },
    }
  )
  for await (const _ of events) {
    /* The stream ends with the error of `stop`. */
  }
  if (!payload) throw new Error("pi-ai built no request")
  return {
    system: withoutCacheControl(
      Array.isArray(payload.system) ? payload.system : []
    ),
    tools: withoutCacheControl(
      Array.isArray(payload.tools) ? payload.tools : []
    ),
    betas: Array.isArray(payload.betas)
      ? payload.betas.filter((beta) => typeof beta === "string")
      : [],
  }
}

type Payload = Awaited<ReturnType<typeof anthropicPayload>>

/** A count request, keyed by model and the SHA-256 of its exact body. */
function unitOf(model: Model<Api>, betas: readonly string[], body: Body): Unit {
  const key = `${model.provider}/${model.id}\0${sha256(
    JSON.stringify({ betas: [...betas].sort(), body })
  )}`
  return { key, body }
}

/** The count requests of a prompt and its tools. */
export function countUnits(
  model: Model<Api>,
  payload: Payload,
  input: TokenInput
) {
  const unit = (body: Body) => unitOf(model, payload.betas, body)
  const baseline = unit({})
  const parts = partTexts(input.sections).map(
    ([id, text]) => [id, unit({ system: [{ type: "text", text }] })] as const
  )
  const prompt = unit({ system: payload.system })
  const toolsAll =
    payload.tools.length > 0 ? unit({ tools: payload.tools }) : undefined
  const anchor = unit({ tools: [ANCHOR_TOOL] })
  // The tools of the request, in the order of `input.tools`; a placeholder
  // that pi-ai adds is part of the total only.
  const definitions = payload.tools.filter(
    (tool) => !(tool as { name?: string }).name?.startsWith(PLACEHOLDER_PREFIX)
  )
  const tools = input.tools.map((tool, index) => {
    const definition = definitions[index]
    return [
      tool.name,
      definition ? unit({ tools: [ANCHOR_TOOL, definition] }) : undefined,
    ] as const
  })
  const all = [
    baseline,
    ...parts.map(([, part]) => part),
    prompt,
    ...(toolsAll ? [toolsAll, anchor] : []),
    ...tools.flatMap(([, tool]) => (tool ? [tool] : [])),
  ]
  return { baseline, parts, prompt, toolsAll, anchor, tools, all }
}

type Units = ReturnType<typeof countUnits>

class RateLimited extends Error {}

export type PromptTokenCounterOptions = {
  /** The JSON file of the cache. */
  file: string
  models: Auth
  fetch?: typeof fetch
  now?: () => number
}

/** Counts with Anthropic's count_tokens, cached; else estimates. */
export class PromptTokenCounter {
  readonly #file: string
  readonly #models: Auth
  readonly #fetch: typeof fetch
  readonly #now: () => number
  /** Input tokens of a request, by `model\0sha256`, oldest first. */
  readonly #cache = new Map<string, number>()
  readonly #inFlight = new Map<string, Promise<number>>()
  readonly #queue: Array<() => void> = []
  #running = 0
  #saveTimer: NodeJS.Timeout | undefined
  /** No calls until this time: after a rate limit or an error. */
  #pausedUntil = 0
  #pauseNote: string | undefined
  /** Requests sent to the API, for tests. */
  calls = 0

  constructor(options: PromptTokenCounterOptions) {
    this.#file = options.file
    this.#models = options.models
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
    try {
      const stored = JSON.parse(readFileSync(this.#file, "utf8")) as {
        counts?: Record<string, unknown>
      }
      for (const [key, value] of Object.entries(stored.counts ?? {}))
        if (typeof value === "number") this.#cache.set(key, value)
    } catch {
      /* No cache yet. */
    }
  }

  /**
   * The counts of a prompt. Without `wait`, only cached exact counts are
   * used, and the missing ones are counted in the background (`pending`).
   * With `wait`, the missing ones are counted first.
   */
  async count(
    input: TokenInput,
    options: { wait?: boolean } = {}
  ): Promise<PromptTokens> {
    const estimated = estimateTokens(input)
    const { model } = input
    if (!model || !canCountExactly(model)) return estimated
    const fallback = (note: string): PromptTokens => ({
      ...estimated,
      note,
    })
    let auth: ModelAuth | undefined
    try {
      auth = (await this.#models.getAuth(model))?.auth
    } catch {
      auth = undefined
    }
    if (!auth?.apiKey) return fallback("No Anthropic credentials")
    const target = (auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "")
    if (target !== "https://api.anthropic.com")
      return fallback("The model uses a proxy")
    let payload: Payload
    try {
      payload = await anthropicPayload(model, auth, input)
    } catch (error) {
      console.warn("[smith] could not build the count request:", error)
      return fallback("Could not build the request")
    }
    const units = countUnits(model, payload, input)
    const missing = units.all.filter((unit) => !this.#cache.has(unit.key))
    let pending = false
    if (missing.length > 0) {
      const counting = this.#countAll(model, auth, payload.betas, missing)
      if (options.wait) {
        let timer: NodeJS.Timeout | undefined
        await Promise.race([
          counting,
          new Promise((done) => {
            timer = setTimeout(done, WAIT_TIMEOUT_MS)
            timer.unref()
          }),
        ])
        clearTimeout(timer)
      } else {
        void counting
      }
      pending = units.all.some((unit) => !this.#cache.has(unit.key))
    }
    return this.#result(estimated, units, {
      pending: pending && this.#now() >= this.#pausedUntil,
      ...(units.all.some((unit) => !this.#cache.has(unit.key)) &&
      this.#pauseNote
        ? { note: this.#pauseNote }
        : {}),
    })
  }

  #result(
    estimated: PromptTokens,
    units: Units,
    extra: { pending: boolean; note?: string }
  ): PromptTokens {
    const raw = (unit: Unit | undefined) =>
      unit ? this.#cache.get(unit.key) : undefined
    const baseline = raw(units.baseline)
    const delta = (
      unit: Unit | undefined,
      from: number | undefined,
      fallback: TokenCount
    ): TokenCount => {
      const value = raw(unit)
      return value === undefined || from === undefined
        ? fallback
        : { tokens: Math.max(0, value - from), exact: true }
    }
    const parts: Record<string, TokenCount> = {}
    for (const [id, unit] of units.parts)
      parts[id] = delta(unit, baseline, estimated.parts[id] ?? estimate(0))
    const prompt = delta(units.prompt, baseline, estimated.prompt)
    const anchor = raw(units.anchor)
    const items = units.tools.map(([name, unit], index) => ({
      name,
      ...delta(unit, anchor, estimated.tools.items[index] ?? estimate(0)),
    }))
    const total = units.toolsAll
      ? delta(units.toolsAll, baseline, estimated.tools.total)
      : estimate(0)
    const listed = sum(items)
    const tools: PromptTokens["tools"] = {
      total,
      items,
      ...(total.exact && listed.exact && items.length > 0
        ? {
            overhead: {
              tokens: Math.max(0, total.tokens - listed.tokens),
              exact: true,
            },
          }
        : {}),
    }
    return {
      ...estimated,
      method: "exact",
      pending: extra.pending,
      ...(extra.note ? { note: extra.note } : {}),
      parts,
      prompt,
      tools,
      total: sum([prompt, total]),
    }
  }

  async #countAll(
    model: Model<Api>,
    auth: ModelAuth,
    betas: readonly string[],
    units: readonly Unit[]
  ) {
    await Promise.allSettled(
      units.map((unit) => this.#countOne(model, auth, betas, unit))
    )
  }

  #countOne(
    model: Model<Api>,
    auth: ModelAuth,
    betas: readonly string[],
    unit: Unit
  ) {
    const running = this.#inFlight.get(unit.key)
    if (running) return running
    const promise = this.#slot(async () => {
      const cached = this.#cache.get(unit.key)
      if (cached !== undefined) return cached
      if (this.#now() < this.#pausedUntil)
        throw new RateLimited(this.#pauseNote ?? "Paused")
      const tokens = await this.#request(model, auth, betas, unit.body)
      this.#remember(unit.key, tokens)
      return tokens
    }).finally(() => this.#inFlight.delete(unit.key))
    this.#inFlight.set(unit.key, promise)
    return promise
  }

  /** Run `task` when fewer than `CONCURRENCY` calls run. */
  async #slot<T>(task: () => Promise<T>) {
    if (this.#running >= CONCURRENCY)
      await new Promise<void>((done) => this.#queue.push(done))
    else this.#running += 1
    try {
      return await task()
    } finally {
      // Hand the slot to the next call, or free it.
      const next = this.#queue.shift()
      if (next) next()
      else this.#running -= 1
    }
  }

  async #request(
    model: Model<Api>,
    auth: ModelAuth,
    betas: readonly string[],
    body: Body
  ) {
    const apiKey = auth.apiKey ?? ""
    const oauth = apiKey.includes("sk-ant-oat")
    this.calls += 1
    let response: Response
    try {
      response = await this.#fetch(COUNT_URL, {
        method: "POST",
        headers: {
          ...auth.headers,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...(betas.length > 0 ? { "anthropic-beta": betas.join(",") } : {}),
          ...(oauth
            ? { authorization: `Bearer ${apiKey}` }
            : { "x-api-key": apiKey }),
        },
        body: JSON.stringify({ model: model.id, messages: MESSAGES, ...body }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      })
    } catch (error) {
      this.#pause(60_000, "Could not reach Anthropic")
      throw error
    }
    if (response.status === 429 || response.status === 529) {
      const after = Number(response.headers.get("retry-after"))
      this.#pause(
        (Number.isFinite(after) && after > 0 ? after : 30) * 1000,
        "Rate limited by Anthropic"
      )
      throw new RateLimited("Rate limited")
    }
    if (!response.ok) {
      this.#pause(
        FAILURE_PAUSE_MS,
        `count_tokens failed (HTTP ${response.status})`
      )
      throw new Error(`count_tokens: HTTP ${response.status}`)
    }
    const result = (await response.json()) as { input_tokens?: unknown }
    if (typeof result.input_tokens !== "number")
      throw new Error("count_tokens: no input_tokens")
    return result.input_tokens
  }

  #pause(ms: number, note: string) {
    this.#pausedUntil = Math.max(this.#pausedUntil, this.#now() + ms)
    this.#pauseNote = note
  }

  #remember(key: string, tokens: number) {
    this.#cache.delete(key)
    this.#cache.set(key, tokens)
    while (this.#cache.size > MAX_ENTRIES) {
      const oldest = this.#cache.keys().next().value
      if (oldest === undefined) break
      this.#cache.delete(oldest)
    }
    this.#scheduleSave()
  }

  #scheduleSave() {
    if (this.#saveTimer) return
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined
      this.save()
    }, 1000)
    this.#saveTimer.unref()
  }

  /** Write the cache file now. */
  save() {
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      const temp = `${this.#file}.tmp`
      writeFileSync(
        temp,
        JSON.stringify({ version: 1, counts: Object.fromEntries(this.#cache) })
      )
      renameSync(temp, this.#file)
    } catch (error) {
      console.warn("[smith] could not save the token counts:", error)
    }
  }
}
