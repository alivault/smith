/**
 * The `scratchpad` extension: large tool output kept out of the model's
 * context.
 *
 * When the `scratchSpillKb` setting is above 0, an `afterTool` hook saves
 * tool output larger than that to a file and gives the model the head of it
 * and the file path. The model reads the rest with `read` or `bash`.
 *
 * Entries are files in `<data>/scratch/<conversation>/`, each with a small
 * JSON file of metadata. Files, not a document, because a tool hook can read
 * documents but not commit them. The web client lists them.
 *
 * Entries do not stay for ever: each `put` applies the limits
 * (`SCRATCH_MAX_ENTRIES`, `SCRATCH_MAX_AGE_MS`) to its conversation, and a
 * sweep at startup also deletes the folders of conversations that no longer
 * exist. Archived agents keep their entries, because they can come back.
 */
import { randomBytes } from "node:crypto"
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  defineExtension,
  hook,
  ToolTask,
  type Conversation,
  type ConversationId,
  type Harness,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable"

import type { HostBridge } from "./host.ts"
import { registerState } from "./util.ts"

export type ScratchEntry = {
  id: string
  name: string
  bytes: number
  lines: number
  createdAt: number
  /** The tool whose output was spilled here, if any. */
  source?: string
}

const ID = /^x[a-z0-9]{6,12}$/
/** The files of an entry: its text and its metadata. */
const ENTRY_FILE = /^(x[a-z0-9]{6,12})\.(txt|json)$/
/** Folders of the scratchpad are named after a conversation ID. */
const CONVERSATION_DIR = /^[1-9][0-9]{0,15}$/

/** A conversation keeps at most this many entries, the newest. */
export const SCRATCH_MAX_ENTRIES = 50
/** Entries older than this go. */
export const SCRATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/**
 * Entries younger than this stay, also beyond `SCRATCH_MAX_ENTRIES`: an
 * agent in the middle of a turn can still read the output it just spilled.
 */
export const SCRATCH_MIN_AGE_MS = 10 * 60 * 1000

export type ScratchSweep = {
  /** Folders of conversations that no longer exist. */
  removedFolders: number
  removedEntries: number
  freedBytes: number
}
const SPILL_HEAD_CHARS = 2000
/** Tools that read a spill file, or that spill on their own. */
const NEVER_SPILL = new Set(["read", "codemode"])

/** The argument that best tells one call of a tool from another. */
const NAME_ARGS = [
  "command",
  "query",
  "queries",
  "url",
  "urls",
  "path",
  "pattern",
  "expression",
  "selector",
  "text",
  "goal",
  "message",
] as const

/**
 * The name of a spilled output: the tool and what the call did, as
 * `bash · pnpm check` or `browser · open https://…`, so entries of one tool
 * differ in the list.
 */
export function spillName(tool: string, args: unknown, max = 60) {
  const record =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {}
  const text = (value: unknown): string | undefined => {
    if (typeof value === "string") return value
    if (Array.isArray(value)) return text(value[0])
    return undefined
  }
  const action = typeof record.action === "string" ? record.action : undefined
  const detail = NAME_ARGS.map((key) => text(record[key])).find(
    (value) => value !== undefined && value.trim() !== ""
  )
  const what = [action, detail]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  if (!what) return `${tool} output`
  const short = what.length > max ? `${what.slice(0, max - 1)}…` : what
  return `${tool} · ${short}`
}

export class Scratchpad {
  readonly #root: string

  constructor(dataDir: string) {
    this.#root = join(dataDir, "scratch")
  }

  #dir(conversationId: ConversationId | number) {
    return join(this.#root, String(conversationId))
  }

  static newId() {
    return `x${randomBytes(5).toString("hex").slice(0, 8)}`
  }

  async put(
    conversationId: ConversationId | number,
    content: string,
    options: { id?: string; name?: string; source?: string } = {}
  ): Promise<ScratchEntry> {
    const id = options.id ?? Scratchpad.newId()
    const dir = this.#dir(conversationId)
    await mkdir(dir, { recursive: true })
    const entry: ScratchEntry = {
      id,
      name: (options.name ?? options.source ?? "note").slice(0, 120),
      bytes: Buffer.byteLength(content),
      lines: content.split("\n").length,
      createdAt: Date.now(),
      ...(options.source ? { source: options.source } : {}),
    }
    await writeFile(join(dir, `${id}.txt`), content)
    await writeFile(join(dir, `${id}.json`), JSON.stringify(entry))
    await this.prune(conversationId).catch((error: unknown) =>
      console.warn("[smith] could not prune the scratchpad:", error)
    )
    return entry
  }

  /** The file of an entry of the conversation. */
  path(conversationId: ConversationId | number, id: string) {
    return join(this.#dir(conversationId), `${id}.txt`)
  }

  async list(conversationId: ConversationId | number) {
    const dir = this.#dir(conversationId)
    const names = await readdir(dir).catch(() => [] as string[])
    const entries: ScratchEntry[] = []
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      try {
        entries.push(
          JSON.parse(await readFile(join(dir, name), "utf8")) as ScratchEntry
        )
      } catch {
        // A partly written entry; skip it.
      }
    }
    return entries.sort((left, right) => left.createdAt - right.createdAt)
  }

  /** The directory of an entry: the conversation's own, or any other. */
  async #find(conversationId: ConversationId | number, id: string) {
    if (!ID.test(id)) return undefined
    const own = this.#dir(conversationId)
    const ownText = await readFile(join(own, `${id}.txt`), "utf8").catch(
      () => undefined
    )
    if (ownText !== undefined) return { dir: own, text: ownText }
    for (const name of await readdir(this.#root).catch(() => [] as string[])) {
      const dir = join(this.#root, name)
      const text = await readFile(join(dir, `${id}.txt`), "utf8").catch(
        () => undefined
      )
      if (text !== undefined) return { dir, text }
    }
    return undefined
  }

  async get(conversationId: ConversationId | number, id: string) {
    return (await this.#find(conversationId, id))?.text
  }

  async delete(conversationId: ConversationId | number, id: string) {
    if (!ID.test(id)) return false
    const dir = this.#dir(conversationId)
    const existed = await readFile(join(dir, `${id}.json`)).then(
      () => true,
      () => false
    )
    await rm(join(dir, `${id}.txt`), { force: true })
    await rm(join(dir, `${id}.json`), { force: true })
    await rmdir(dir).catch(() => undefined)
    return existed
  }

  /** Delete all entries of a conversation. Returns how many there were. */
  async clear(conversationId: ConversationId | number) {
    const count = (await this.list(conversationId)).length
    await this.#removeFolder(String(conversationId))
    return count
  }

  /**
   * Apply the limits to the entries of one conversation: at most
   * `SCRATCH_MAX_ENTRIES`, none older than `SCRATCH_MAX_AGE_MS`, but never
   * an entry younger than `SCRATCH_MIN_AGE_MS`.
   */
  async prune(conversationId: ConversationId | number, now = Date.now()) {
    const result = { removedEntries: 0, freedBytes: 0 }
    const dir = this.#dir(conversationId)
    if (!(await isRealDirectory(dir))) return result
    // The files of each entry, and its time: the metadata's, or else the
    // newest file's (a text file without metadata).
    const files = new Map<string, { names: string[]; time: number }>()
    for (const dirent of await readdir(dir, { withFileTypes: true })) {
      const match = ENTRY_FILE.exec(dirent.name)
      if (!match || !dirent.isFile()) continue
      const id = match[1]!
      const path = join(dir, dirent.name)
      const info = await lstat(path).catch(() => undefined)
      if (!info) continue
      let time = info.mtimeMs
      if (match[2] === "json") {
        try {
          const entry = JSON.parse(await readFile(path, "utf8")) as {
            createdAt?: unknown
          }
          if (typeof entry.createdAt === "number") time = entry.createdAt
        } catch {
          // Partly written: use the file time.
        }
      }
      const known = files.get(id)
      if (known) {
        known.names.push(dirent.name)
        if (match[2] === "json") known.time = time
      } else files.set(id, { names: [dirent.name], time })
    }
    const entries = [...files.values()].sort(
      (left, right) => right.time - left.time
    )
    for (const [index, entry] of entries.entries()) {
      const age = now - entry.time
      if (age < SCRATCH_MIN_AGE_MS) continue
      if (index < SCRATCH_MAX_ENTRIES && age <= SCRATCH_MAX_AGE_MS) continue
      for (const name of entry.names) {
        const path = join(dir, name)
        const info = await lstat(path).catch(() => undefined)
        if (!info?.isFile()) continue
        await rm(path, { force: true })
        result.freedBytes += info.size
      }
      result.removedEntries += 1
    }
    if (result.removedEntries > 0) await rmdir(dir).catch(() => undefined)
    return result
  }

  /**
   * At startup: delete the folders of conversations that no longer exist and
   * apply the limits to the others. With `existing` undefined (the
   * conversations could not be read), no folder goes as a whole.
   */
  async sweep(
    existing: ReadonlySet<string> | undefined,
    now = Date.now()
  ): Promise<ScratchSweep> {
    const result: ScratchSweep = {
      removedFolders: 0,
      removedEntries: 0,
      freedBytes: 0,
    }
    if (!(await isRealDirectory(this.#root))) return result
    for (const dirent of await readdir(this.#root, { withFileTypes: true })) {
      if (!dirent.isDirectory() || !CONVERSATION_DIR.test(dirent.name)) continue
      const dir = join(this.#root, dirent.name)
      if (existing && !existing.has(dirent.name)) {
        // A folder that changed lately may belong to a conversation made
        // after `existing` was read.
        const info = await lstat(dir).catch(() => undefined)
        if (!info?.isDirectory() || now - info.mtimeMs < SCRATCH_MIN_AGE_MS)
          continue
        const bytes = await folderBytes(dir)
        if (await this.#removeFolder(dirent.name)) {
          result.removedFolders += 1
          result.freedBytes += bytes
        }
        continue
      }
      const pruned = await this.prune(Number(dirent.name), now)
      result.removedEntries += pruned.removedEntries
      result.freedBytes += pruned.freedBytes
    }
    return result
  }

  /** Delete a conversation's folder; only a real folder in the scratchpad. */
  async #removeFolder(name: string) {
    if (!CONVERSATION_DIR.test(name)) return false
    if (!(await isRealDirectory(this.#root))) return false
    const dir = join(this.#root, name)
    if (!(await isRealDirectory(dir))) return false
    // `rm` removes symbolic links inside, it does not follow them.
    await rm(dir, { recursive: true, force: true })
    return true
  }
}

async function isRealDirectory(path: string) {
  const info = await lstat(path).catch(() => undefined)
  return Boolean(info?.isDirectory())
}

/** The size of the files in a folder, without following links. */
async function folderBytes(dir: string): Promise<number> {
  let total = 0
  const dirents = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const dirent of dirents) {
    const path = join(dir, dirent.name)
    if (dirent.isDirectory()) total += await folderBytes(path)
    else if (dirent.isFile())
      total += (await lstat(path).catch(() => undefined))?.size ?? 0
  }
  return total
}

/** The IDs of all conversations in the database, or undefined on an error. */
async function conversationIds(harness: Harness) {
  try {
    const ids = new Set<string>()
    let cursor: Parameters<Conversation["entries"]>[2]
    do {
      const page = await harness.commit(
        (tx) => tx.scanConversations({}, 500, cursor),
        BACKGROUND_CONTEXT
      )
      for (const record of page.items) ids.add(String(record.id))
      cursor = page.next
    } while (cursor)
    return ids
  } catch (error) {
    console.warn("[smith] could not read the conversations:", error)
    return undefined
  }
}

/** Format a byte count for the log. */
function megabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function resultText(result: ToolExecutionResult) {
  if (!result.output) return undefined
  if (result.output.some((part) => part.type !== "text")) return undefined
  return result.output
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
}

export function createScratchpadExtension(host: HostBridge, dataDir: string) {
  const scratch = new Scratchpad(dataDir)

  registerState({
    key: "scratch",
    kinds: [],
    async read(_reader, conversationId) {
      const entries = await scratch.list(conversationId)
      return entries.length > 0 ? entries : undefined
    },
  })

  // One sweep at startup, in the background.
  host.onReady((services) => {
    void (async () => {
      const result = await scratch.sweep(
        await conversationIds(services.harness)
      )
      console.log(
        `[smith] scratchpad: freed ${megabytes(result.freedBytes)} (${result.removedFolders} folders of deleted conversations, ${result.removedEntries} old entries)`
      )
    })().catch((error: unknown) =>
      console.warn("[smith] could not clean the scratchpad:", error)
    )
  })

  const spill = hook(ToolTask, {
    afterTool: async (call, result, api) => {
      const limitKb = host.current?.settings().scratchSpillKb ?? 0
      if (limitKb <= 0 || call.parent || NEVER_SPILL.has(call.name))
        return undefined
      const text = resultText(result)
      if (text === undefined || Buffer.byteLength(text) <= limitKb * 1024)
        return undefined
      const entry = await scratch.put(api.conversationId, text, {
        source: call.name,
        name: spillName(call.name, call.arguments),
      })
      return {
        ...result,
        output: [
          {
            type: "text",
            text: `${text.slice(0, SPILL_HEAD_CHARS)}\n…\n[The full output (${entry.lines} lines, ${entry.bytes} bytes) is in the file ${scratch.path(api.conversationId, entry.id)}. Read more of it with read (offset, limit) or with rg in bash.]`,
          },
        ],
      }
    },
  })

  return {
    scratch,
    extension: defineExtension({
      name: "scratchpad",
      hooks: [spill],
    }),
  }
}
