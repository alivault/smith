/**
 * The `todo` extension: a task list that the agent keeps for an agent.
 *
 * The list is a conversation document, not text in the transcript, so it
 * survives compaction. A prompt section shows the open items to the model.
 * Tree navigation sees the list as it was at the fork point (`asOf`).
 */
import type { Context } from "@earendil-works/chord/context"
import Type from "typebox"
import {
  defineDoc,
  defineExtension,
  defineTool,
  section,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable"

import { StringEnum } from "../core/schema.ts"
import { json, registerState, textResult } from "./util.ts"

export type TodoStatus = "pending" | "active" | "done" | "blocked"

export type TodoItem = {
  id: string
  text: string
  status: TodoStatus
  note?: string
}

export type TodoState = {
  items: TodoItem[]
  nextId: number
  /** Tool calls already applied, so a rerun after a crash does not apply twice. */
  applied: string[]
  updatedAt: number
}

export const TodoDoc = defineDoc<TodoState>({
  kind: "smith.todo",
  checkpointWhen: () => false,
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ items: [], nextId: 1, applied: [], updatedAt: 0 }),
})

const STATUSES = ["pending", "active", "done", "blocked"] as const

type TodoInput = { text: string; status?: TodoStatus; note?: string }

export type TodoChange =
  | { op: "set"; items: Array<TodoInput> }
  | { op: "add"; items: Array<TodoInput> }
  | {
      op: "update"
      id: string
      status?: TodoStatus
      text?: string
      note?: string
    }
  | { op: "remove"; id: string }
  | { op: "clear"; scope?: "done" | "all" }

/** Apply a change to the list. Throws when an item does not exist. */
export function applyTodo(state: TodoState, change: TodoChange) {
  const add = ({ text, status = "pending", note }: TodoInput) => {
    const trimmed = typeof text === "string" ? text.trim() : ""
    if (!trimmed) return
    const trimmedNote = typeof note === "string" ? note.trim() : ""
    state.items.push({
      id: String(state.nextId++),
      text: trimmed,
      status,
      ...(trimmedNote ? { note: trimmedNote } : {}),
    })
  }
  const find = (id: string) => {
    const item = state.items.find((entry) => entry.id === String(id).trim())
    if (!item) throw new Error(`No todo item with id ${id}`)
    return item
  }
  switch (change.op) {
    case "set":
      state.items.splice(0, state.items.length)
      for (const item of change.items) add(item)
      break
    case "add":
      for (const item of change.items) add(item)
      break
    case "update": {
      const item = find(change.id)
      if (change.status) item.status = change.status
      if (change.text?.trim()) item.text = change.text.trim()
      if (change.note !== undefined) {
        if (change.note.trim()) item.note = change.note.trim()
        else delete item.note
      }
      // One item is active at a time; starting one pauses the others.
      if (change.status === "active") {
        for (const other of state.items)
          if (other !== item && other.status === "active")
            other.status = "pending"
      }
      break
    }
    case "remove": {
      const item = find(change.id)
      state.items.splice(state.items.indexOf(item), 1)
      break
    }
    case "clear": {
      const keep =
        change.scope === "all"
          ? []
          : state.items.filter((item) => item.status !== "done")
      state.items.splice(0, state.items.length, ...keep)
      break
    }
  }
  state.updatedAt = Date.now()
}

const MARK: Record<TodoStatus, string> = {
  pending: "[ ]",
  active: "[>]",
  done: "[x]",
  blocked: "[!]",
}

export function formatTodo(items: readonly TodoItem[]) {
  if (items.length === 0) return "The todo list is empty."
  const done = items.filter((item) => item.status === "done").length
  return [
    `Todo (${done}/${items.length} done):`,
    ...items.map(
      (item) =>
        `${MARK[item.status]} ${item.id}. ${item.text}${item.note ? ` — ${item.note}` : ""}`
    ),
  ].join("\n")
}

function shortTodo(
  items: readonly TodoItem[],
  change: Extract<TodoChange, { op: "update" | "remove" }>
) {
  const done = items.filter((item) => item.status === "done").length
  const item = items.find((entry) => entry.id === change.id)
  const next = items.find(
    (entry) => entry.status === "active" || entry.status === "pending"
  )
  return [
    change.op === "remove"
      ? `Removed item ${change.id}.`
      : `Item ${change.id} is ${item?.status ?? "changed"}: ${item?.text ?? ""}`,
    `${done}/${items.length} done.`,
    next && next !== item ? `Next: ${next.id}. ${next.text}` : "",
  ]
    .filter(Boolean)
    .join(" ")
}

/** Change an agent's list from outside a tool, for the web client. */
export async function updateTodo(
  harness: Harness,
  conversationId: ConversationId,
  change: TodoChange,
  context: Context
) {
  return harness.commit(async (tx) => {
    const draft = await tx.doc(TodoDoc, conversationId)
    applyTodo(draft as TodoState, change)
    return json(draft.items as TodoItem[])
  }, context)
}

const TEXT_DESCRIPTION =
  "Short title, at most about 8 words; shown in a one-line progress chip"
const NOTE_DESCRIPTION =
  "Details: the plan, links, agent IDs, decisions, or why it is blocked"

const itemSchema = Type.Object({
  text: Type.String({ description: TEXT_DESCRIPTION }),
  status: Type.Optional(StringEnum(STATUSES)),
  note: Type.Optional(Type.String({ description: NOTE_DESCRIPTION })),
})

const todoTool = defineTool({
  name: "todo",
  description: [
    "A todo list for work with 3 or more steps. The user sees it as a live checklist; it survives compaction.",
    "Ops: set (replace the list), add, update (status, text, or note of item id), remove, clear (scope: done (default) or all), list.",
    "Keep the title short and put the rest in note. Mark one item active while you work on it, and done when it is finished.",
  ].join(" "),
  parameters: Type.Object({
    op: StringEnum(["set", "add", "update", "remove", "clear", "list"]),
    items: Type.Optional(Type.Array(itemSchema)),
    id: Type.Optional(Type.String()),
    status: Type.Optional(StringEnum(STATUSES)),
    text: Type.Optional(Type.String({ description: "add, update: title" })),
    note: Type.Optional(Type.String({ description: "add, update: details" })),
    scope: Type.Optional(StringEnum(["done", "all"])),
  }),
  replay: "safe",
  async execute(args, api, context) {
    const change = toChange(args as Record<string, unknown>)
    const items = await api.commit(async (tx) => {
      const draft = (await tx.doc(
        TodoDoc,
        api.conversationId
      )) as unknown as TodoState
      if (change && !draft.applied.includes(api.callId)) {
        applyTodo(draft, change)
        draft.applied.push(api.callId)
        if (draft.applied.length > 50)
          draft.applied.splice(0, draft.applied.length - 50)
      }
      return json(draft.items)
    }, context)
    // A full list after set, add, and list; a short line after small changes.
    const text =
      change && (change.op === "update" || change.op === "remove")
        ? shortTodo(items, change)
        : formatTodo(items)
    return textResult(text, { details: { items } })
  },
})

function toChange(args: Record<string, unknown>): TodoChange | undefined {
  const op = String(args.op)
  const items = Array.isArray(args.items)
    ? (args.items as Array<TodoInput>)
    : []
  const id = typeof args.id === "string" ? args.id : undefined
  switch (op) {
    case "set":
      return { op, items }
    case "add":
      if (items.length === 0 && typeof args.text === "string")
        return {
          op,
          items: [
            {
              text: args.text,
              ...(typeof args.note === "string" ? { note: args.note } : {}),
            },
          ],
        }
      return { op, items }
    case "update":
      if (!id) throw new Error("update needs an id")
      return {
        op,
        id,
        ...(typeof args.status === "string"
          ? { status: args.status as TodoStatus }
          : {}),
        ...(typeof args.text === "string" ? { text: args.text } : {}),
        ...(typeof args.note === "string" ? { note: args.note } : {}),
      }
    case "remove":
      if (!id) throw new Error("remove needs an id")
      return { op, id }
    case "clear":
      return { op, scope: args.scope === "all" ? "all" : "done" }
    default:
      return undefined
  }
}

registerState({
  key: "todo",
  kinds: ["smith.todo"],
  async read(reader, conversationId, context) {
    const state = await reader.snapshot(TodoDoc, conversationId, context)
    return state && state.items.length > 0
      ? { items: json(state.items as TodoItem[]), updatedAt: state.updatedAt }
      : undefined
  },
})

export function createTodoExtension() {
  return defineExtension({
    name: "todo",
    tools: [todoTool],
    sections: [
      section("todo", async (input, context) => {
        const state = await input.read.snapshot(
          TodoDoc,
          input.conversationId,
          context
        )
        const open = state?.items.filter((item) => item.status !== "done")
        if (!state || !open || open.length === 0) return undefined
        return `${formatTodo(state.items)}\nKeep this list current with the todo tool.`
      }),
    ],
  })
}
