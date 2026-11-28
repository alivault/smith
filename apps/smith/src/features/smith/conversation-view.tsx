"use client"

import * as React from "react"
import { PatchDiff } from "@pierre/diffs/react"
import {
  CheckIcon,
  CircleCheckIcon,
  CircleStopIcon,
  CircleXIcon,
  CopyIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  PencilIcon,
  SquareTerminalIcon,
  InfoIcon,
  EyeIcon,
  AlarmClockIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react"

import type {
  ConversationImage,
  ConversationItem,
  PromptImage,
} from "@/lib/smith"
import { sameConversationImages } from "@/lib/smith/sync"
import {
  CodeBlock,
  copyTextToClipboard,
  MarkdownBlock,
} from "@/features/smith/markdown-renderer"
import { ImageLightbox } from "@/features/smith/image-lightbox"
import {
  ToolResultImages,
  useConversationImageSrc,
} from "@/features/smith/tool-result-images"
import { useSmithDiffThemeOptions } from "@/features/smith/smith-diff-theme"
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
} from "@/components/ui/trace"
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from "@/components/ai-elements/chain-of-thought"
import {
  Reasoning,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning"
import { Sources } from "@/components/ai-elements/sources"
import { StackTrace } from "@/components/ai-elements/stack-trace"
import { AnsiText, Terminal } from "@/components/ai-elements/terminal"
import {
  TestResults,
  TestResultsCounts,
} from "@/components/ai-elements/test-results"
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool"
import { Badge } from "@/components/ui/badge"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Message, MessageContent, MessageFooter } from "@/components/ui/message"
import { Button } from "@/components/ui/button"
import { TitleTooltip } from "@/components/ui/tooltip"
import {
  getToolArgNumber,
  getToolArgText,
  normalizeToolArgs,
  rawShellCommandTextFromTool,
  searchToolSummary,
} from "@/lib/smith/tool-args"
import {
  assistantBlockDescriptors,
  assistantBlockIsVisible,
  assistantBlockKey,
  assistantBlockRenderKeys,
  reconcileAssistantBlockDescriptors,
  type AssistantBlockDescriptor,
  type AssistantConversationBlock,
} from "@/features/smith/assistant-blocks"
import {
  parseStackTrace,
  parseTestSummary,
  parseWebSources,
  type StackFrame,
} from "@/lib/smith/tool-output-detect"
import { cn } from "@/lib/utils"
import "@/features/smith/agent/register"
import { toolRenderer } from "@/features/smith/tool-renderers/registry"
import { useMachineId } from "@/lib/smith/machine-context"
import {
  isLocalAgentId,
  parseAgentNotice,
  type AgentNotice,
  type AgentNoticeTone,
} from "@/lib/smith/agent-notice"
import { emitSmithEvent } from "@/features/smith/agent/events"
import { FileLinkText, LinkifiedOutput } from "@/features/smith/file-links"
import {
  formatFileReference,
  type FileReference,
} from "@/lib/smith/file-references"

export function promptImageKey(
  image: Pick<PromptImage, "previewUrl" | "data">
) {
  return `${image.previewUrl}:${image.data.slice(0, 24)}`
}

function userMessageLabel(item: Extract<ConversationItem, { kind: "user" }>) {
  if (item.streamingBehavior === "steer") return "Steer"
  if (item.queued || item.streamingBehavior === "followUp") return "Queue"
  return ""
}

function toolDisplayName(name?: string) {
  switch (name) {
    case "bash":
      return "Bash"
    case "read":
      return "Read"
    case "write":
      return "Write"
    case "edit":
      return "Edit"
    case "grep":
      return "Grep"
    case "glob":
      return "Glob"
    case "find":
      return "Find"
    case "rg":
      return "Ripgrep"
    case "ls":
    case "list":
      return "List"
    default:
      return name || "Tool"
  }
}

function toolCommandPreview(
  block: Extract<ConversationItem, { kind: "assistant" }>["blocks"][number]
) {
  if (block.type !== "tool") return ""

  if (typeof block.args === "string" && block.args.trim()) {
    return block.args.trim()
  }

  const args = normalizeToolArgs(block.args)
  return (
    getToolArgText(args, "description") ||
    getToolArgText(args, "command") ||
    getToolArgText(args, "path") ||
    getToolArgText(args, "filePath") ||
    getToolArgText(args, "file_path")
  )
}

function toolReadLocation(
  block: Extract<ConversationItem, { kind: "assistant" }>["blocks"][number]
) {
  if (block.type !== "tool") return ""

  const args = normalizeToolArgs(block.args)
  const filePath =
    getToolArgText(args, "path") ||
    getToolArgText(args, "filePath") ||
    getToolArgText(args, "file_path")
  const offset = args?.offset
  const limit = args?.limit

  if (typeof offset === "number" && typeof limit === "number" && limit > 0) {
    return `${filePath}:${offset}-${offset + limit - 1}`
  }
  if (typeof offset === "number") {
    return `${filePath}:${offset}`
  }
  if (typeof limit === "number" && limit > 0) {
    return `${filePath} limit=${limit}`.trim()
  }
  return filePath
}

/** The first new line of an edit: from its details, or its first hunk. */
function editFirstLine(
  block: Extract<ConversationItem, { kind: "assistant" }>["blocks"][number]
) {
  if (block.type !== "tool" || block.name !== "edit") return undefined
  const details =
    block.details && typeof block.details === "object"
      ? (block.details as Record<string, unknown>)
      : {}
  if (
    typeof details.firstChangedLine === "number" &&
    details.firstChangedLine > 0
  )
    return details.firstChangedLine
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(toolPatchText(block))
  const line = hunk ? Number(hunk[1]) : 0
  return line > 0 ? line : undefined
}

/** The file of a read, write, or edit call, with the lines it read or changed. */
function toolFileTarget(
  block: Extract<ConversationItem, { kind: "assistant" }>["blocks"][number]
): FileReference | null {
  if (block.type !== "tool") return null
  if (block.name !== "read" && block.name !== "write" && block.name !== "edit")
    return null
  const args = normalizeToolArgs(block.args)
  const path =
    getToolArgText(args, "path") ||
    getToolArgText(args, "filePath") ||
    getToolArgText(args, "file_path")
  if (!path) return null
  if (block.name === "edit") {
    const line = editFirstLine(block)
    return line ? { path, line } : { path }
  }
  if (block.name !== "read") return { path }
  const offset = getToolArgNumber(args, "offset")
  const limit = getToolArgNumber(args, "limit")
  if (!offset || offset < 1) return { path }
  return limit && limit > 1
    ? { path, line: offset, endLine: offset + limit - 1 }
    : { path, line: offset }
}

/**
 * A tool summary that starts with the tool's file: the file part is a link
 * to the file viewer when the file exists.
 */
function ToolSummaryText({
  summary,
  file,
}: {
  summary: string
  file: FileReference | null
}) {
  if (!file || !summary.startsWith(file.path)) return summary
  const space = summary.indexOf(" ", file.path.length)
  const end = space < 0 ? summary.length : space
  return (
    <>
      <FileLinkText reference={file} stopPropagation>
        {summary.slice(0, end)}
      </FileLinkText>
      {summary.slice(end)}
    </>
  )
}

function collapseToolPreview(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

function countTextDisplayLines(text: string) {
  if (!text) return 0
  return text.split("\n").length
}

function formatCountLabel(
  count: number,
  singular: string,
  plural = `${singular}s`
) {
  return `${count} ${count === 1 ? singular : plural}`
}

function getWriteToolPayload(
  block: Extract<ConversationItem, { kind: "assistant" }>["blocks"][number]
) {
  if (block.type !== "tool" || block.name !== "write") return undefined

  const args = normalizeToolArgs(block.args)
  if (!args) return undefined

  const path =
    getToolArgText(args, "path") ||
    getToolArgText(args, "filePath") ||
    getToolArgText(args, "file_path")
  const content = args.content

  return {
    content: typeof content === "string" ? content : undefined,
    path,
  }
}

function writeToolSummary(
  block: Extract<ConversationItem, { kind: "assistant" }>["blocks"][number]
) {
  const payload = getWriteToolPayload(block)
  if (!payload?.path) return ""
  if (payload.content === undefined) return payload.path

  return `${payload.path} · ${formatCountLabel(
    countTextDisplayLines(payload.content),
    "line"
  )}`
}

function toolSummary(
  block: Extract<ConversationItem, { kind: "assistant" }>["blocks"][number]
) {
  if (block.type !== "tool") return ""
  const preview =
    block.name === "read"
      ? toolReadLocation(block)
      : block.name === "write"
        ? writeToolSummary(block)
        : searchToolSummary(block.name, block.args) ||
          (block.name === "bash" ? "" : toolCommandPreview(block))
  if (preview) return collapseToolPreview(preview)
  if (block.running) return "Running"
  if (block.isError) return "Failed"
  return "Done"
}

function formatToolArgString(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ""

  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === "object") {
      return JSON.stringify(parsed, null, 2)
    }
  } catch {
    // fall through to the raw string below
  }

  return trimmed
}

function rawShellCommandText(
  block: Extract<ConversationItem, { kind: "assistant" }>["blocks"][number]
) {
  return block.type === "tool"
    ? rawShellCommandTextFromTool(block.name, block.args)
    : ""
}

function toolCallText(
  block: Extract<ConversationItem, { kind: "assistant" }>["blocks"][number]
) {
  if (block.type !== "tool") return ""

  if (block.name === "bash") {
    const command = rawShellCommandText(block)
    return command ? `$ ${command}` : ""
  }

  if (typeof block.args === "string") {
    return formatToolArgString(block.args)
  }

  if (block.args == null) return ""

  try {
    return JSON.stringify(block.args, null, 2) || ""
  } catch {
    return ""
  }
}

function toolPatchText(
  block: Extract<ConversationItem, { kind: "assistant" }>["blocks"][number]
) {
  if (block.type !== "tool" || block.name !== "edit") return ""
  if (!block.details || typeof block.details !== "object") return ""

  const details = block.details as Partial<Record<"patch", unknown>>
  return typeof details.patch === "string" ? details.patch.trimEnd() : ""
}

function toolOutputText(
  block: Extract<ConversationItem, { kind: "assistant" }>["blocks"][number]
) {
  if (block.type !== "tool") return ""

  const parts: Array<string> = []
  const diff = toolPatchText(block)
  const output = block.output.trimEnd()

  if (diff) {
    parts.push(diff)
  }

  if (output && (!diff || output !== diff)) {
    parts.push(output)
  }

  if (parts.length > 0) {
    return parts.join("\n\n")
  }

  if (block.running) return "Running…"
  if (block.isError) return "Tool failed with no output."
  return "No output available."
}

type AssistantToolBlock = AssistantConversationBlock & { type: "tool" }

type AssistantBlockStoreSnapshot = {
  blockByKey: Map<string, AssistantConversationBlock>
  groups: Array<AssistantBlockDescriptor>
  revision: number
}

export type AssistantMessagesSnapshot = {
  items: Array<Extract<ConversationItem, { kind: "assistant" }>>
  hideThinking: boolean
  hideToolBlocks: boolean
}

export type AssistantMessagesStore = {
  getSnapshot: () => AssistantMessagesSnapshot
  subscribe: (listener: () => void) => () => void
}

type AssistantMessagesShellSnapshot = {
  hasBlocks: boolean
  hasFooter: boolean
  hideThinking: boolean
  /** The label of the collapsed work row; empty while the agent works. */
  workLabel: string
  streaming: boolean
  working: boolean
  copyText: string
  modelLabel: string
}

type AssistantMessagesShellStore = {
  getSnapshot: () => AssistantMessagesShellSnapshot
  setSnapshot: (snapshot: AssistantMessagesShellSnapshot) => void
  subscribe: (listener: () => void) => () => void
}

type AssistantBlockStore = {
  getBlock: (key: string) => AssistantConversationBlock | undefined
  getGroups: () => Array<AssistantBlockDescriptor>
  setBlocks: (blocks: Array<AssistantConversationBlock>) => void
  subscribe: (listener: () => void) => () => void
  subscribeBlocks: (keys: Array<string>, listener: () => void) => () => void
}

function sameUnknownValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== typeof right) return false
  if (!left || !right || typeof left !== "object") return false

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false

    for (let index = 0; index < left.length; index += 1) {
      if (!sameUnknownValue(left[index], right[index])) return false
    }

    return true
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  if (leftKeys.length !== rightKeys.length) return false

  for (const key of leftKeys) {
    if (!Object.hasOwn(rightRecord, key)) return false
    if (!sameUnknownValue(leftRecord[key], rightRecord[key])) return false
  }

  return true
}

function sameAssistantBlock(
  left: AssistantConversationBlock,
  right: AssistantConversationBlock
) {
  if (left === right) return true
  if (left.type !== right.type) return false
  if (left.blockKey !== right.blockKey) return false
  if (left.renderKey !== right.renderKey) return false

  switch (left.type) {
    case "text":
      if (right.type !== "text") return false
      return (
        left.text === right.text &&
        Boolean(left.isError) === Boolean(right.isError)
      )
    case "thinking":
      if (right.type !== "thinking") return false
      return (
        left.text === right.text && left.summaryLabel === right.summaryLabel
      )
    case "tool":
      if (right.type !== "tool") return false
      return (
        left.callId === right.callId &&
        left.name === right.name &&
        left.output === right.output &&
        left.isError === right.isError &&
        left.running === right.running &&
        sameUnknownValue(left.args, right.args) &&
        sameUnknownValue(left.details, right.details) &&
        sameConversationImages(left.images, right.images)
      )
    case "compaction":
      if (right.type !== "compaction") return false
      return (
        left.summary === right.summary &&
        left.tokensBefore === right.tokensBefore &&
        left.estimatedTokensAfter === right.estimatedTokensAfter
      )
    default:
      return false
  }
}

function buildAssistantBlockSnapshot(
  blocks: Array<AssistantConversationBlock>,
  previousSnapshot?: AssistantBlockStoreSnapshot
): AssistantBlockStoreSnapshot {
  const blockByKey = new Map<string, AssistantConversationBlock>()
  const keys = assistantBlockRenderKeys(blocks)
  const groups = assistantBlockDescriptors(blocks, keys)

  blocks.forEach((block, index) => {
    const key = keys[index]!
    const previousBlock = previousSnapshot?.blockByKey.get(key)
    blockByKey.set(
      key,
      previousBlock && sameAssistantBlock(previousBlock, block)
        ? previousBlock
        : block
    )
  })

  return {
    blockByKey,
    groups: previousSnapshot
      ? reconcileAssistantBlockDescriptors(previousSnapshot.groups, groups)
      : groups,
    revision: (previousSnapshot?.revision ?? 0) + 1,
  }
}

function sameAssistantMessagesShellSnapshot(
  left: AssistantMessagesShellSnapshot,
  right: AssistantMessagesShellSnapshot
) {
  return (
    left.hasBlocks === right.hasBlocks &&
    left.hasFooter === right.hasFooter &&
    left.hideThinking === right.hideThinking &&
    left.workLabel === right.workLabel &&
    left.streaming === right.streaming &&
    left.working === right.working &&
    left.copyText === right.copyText &&
    left.modelLabel === right.modelLabel
  )
}

function createAssistantMessagesShellStore(
  initialSnapshot: AssistantMessagesShellSnapshot
): AssistantMessagesShellStore {
  let snapshot = initialSnapshot
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => snapshot,
    setSnapshot: (nextSnapshot) => {
      if (sameAssistantMessagesShellSnapshot(snapshot, nextSnapshot)) return

      snapshot = nextSnapshot
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

function visibleAssistantBlocksFromSnapshot(
  snapshot: AssistantMessagesSnapshot
) {
  return snapshot.items.flatMap((item) => {
    // Scope block keys to their message. The streaming message keeps its
    // item render key when the server commits it, so its blocks keep their
    // React identity and do not remount.
    const itemKey = item.renderKey || item.itemKey || ""
    return item.blocks.flatMap((block) => {
      if (
        !assistantBlockIsVisible({
          block,
          hideThinking: snapshot.hideThinking,
          hideToolBlocks: snapshot.hideToolBlocks,
        })
      ) {
        return []
      }
      const blockKey =
        block.renderKey || block.blockKey || assistantBlockKey(block)
      return [{ ...block, renderKey: `${itemKey}/${blockKey}` }]
    })
  })
}

function assistantCopyTextFromItems(
  items: Array<Extract<ConversationItem, { kind: "assistant" }>>
) {
  return items
    .flatMap((item) =>
      item.blocks.flatMap((block) => {
        const text =
          block.type === "text"
            ? block.text
            : block.type === "compaction"
              ? block.summary
              : ""
        return text.trim() ? [text] : []
      })
    )
    .join("\n\n")
    .trim()
}

function formatAssistantModelId(id: string) {
  return id.replace(/^gpt/i, "GPT")
}

function assistantModelLabel(
  item: Extract<ConversationItem, { kind: "assistant" }> | undefined
) {
  const model = item?.model
  if (!model) return ""

  return (model.name || formatAssistantModelId(model.id)).trim()
}

function assistantMessagesModelLabel(
  items: Array<Extract<ConversationItem, { kind: "assistant" }>>
) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const label = assistantModelLabel(items[index])
    if (label) return label
  }

  return ""
}

function formatWorkDuration(milliseconds: number) {
  const totalSeconds = Math.max(1, Math.round(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** "Worked for 4m 3s", from the first response start to the last end. */
function assistantWorkLabel(
  items: Array<Extract<ConversationItem, { kind: "assistant" }>>
) {
  let startedAt: number | undefined
  let endedAt: number | undefined
  for (const item of items) {
    if (item.startedAt === undefined) continue
    startedAt = Math.min(startedAt ?? item.startedAt, item.startedAt)
    const itemEnd = item.endedAt ?? item.startedAt
    endedAt = Math.max(endedAt ?? itemEnd, itemEnd)
  }
  if (
    startedAt === undefined ||
    endedAt === undefined ||
    endedAt <= startedAt
  ) {
    return "Worked"
  }
  return `Worked for ${formatWorkDuration(endedAt - startedAt)}`
}

function assistantItemIsWorking(
  item: Extract<ConversationItem, { kind: "assistant" }>
) {
  return (
    Boolean(item.streaming) ||
    item.done === false ||
    item.blocks.some((block) => block.type === "tool" && block.running)
  )
}

function assistantItemIsStreaming(
  item: Extract<ConversationItem, { kind: "assistant" }>
) {
  return Boolean(item.streaming)
}

function assistantMessagesShellSnapshotFromBlocks(
  snapshot: AssistantMessagesSnapshot,
  blocks: Array<AssistantConversationBlock>
): AssistantMessagesShellSnapshot {
  const modelLabel = assistantMessagesModelLabel(snapshot.items)
  const streaming = snapshot.items.some(assistantItemIsStreaming)
  const working = snapshot.items.some(assistantItemIsWorking)
  // The footer shows only when the message is not working. Do not join the
  // text of a working message on each streamed update.
  const copyText = working ? "" : assistantCopyTextFromItems(snapshot.items)
  const hasFooter = Boolean(copyText.trim() || modelLabel)

  return {
    hasBlocks: blocks.length > 0,
    hasFooter,
    hideThinking: snapshot.hideThinking,
    workLabel: working ? "" : assistantWorkLabel(snapshot.items),
    streaming,
    working,
    copyText,
    modelLabel,
  }
}

function createAssistantBlockStore(
  blocks: Array<AssistantConversationBlock>
): AssistantBlockStore {
  let snapshot = buildAssistantBlockSnapshot(blocks)
  const listeners = new Set<() => void>()
  const blockListeners = new Map<string, Set<() => void>>()

  const notifyBlock = (key: string) => {
    const listenersForBlock = blockListeners.get(key)
    if (!listenersForBlock) return
    for (const listener of listenersForBlock) listener()
  }

  return {
    getBlock: (key) => snapshot.blockByKey.get(key),
    getGroups: () => snapshot.groups,
    setBlocks: (blocks) => {
      const previousSnapshot = snapshot
      const nextSnapshot = buildAssistantBlockSnapshot(blocks, previousSnapshot)
      let blockChanged =
        previousSnapshot.blockByKey.size !== nextSnapshot.blockByKey.size
      const changedKeys = new Set<string>()

      for (const key of previousSnapshot.blockByKey.keys()) {
        if (
          previousSnapshot.blockByKey.get(key) !==
          nextSnapshot.blockByKey.get(key)
        ) {
          changedKeys.add(key)
          blockChanged = true
        }
      }
      for (const key of nextSnapshot.blockByKey.keys()) {
        if (
          previousSnapshot.blockByKey.get(key) !==
          nextSnapshot.blockByKey.get(key)
        ) {
          changedKeys.add(key)
          blockChanged = true
        }
      }

      if (!blockChanged && previousSnapshot.groups === nextSnapshot.groups) {
        return
      }

      snapshot = nextSnapshot
      if (previousSnapshot.groups !== nextSnapshot.groups) {
        for (const listener of listeners) listener()
      }
      for (const key of changedKeys) notifyBlock(key)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    subscribeBlocks: (keys, listener) => {
      const uniqueKeys = [...new Set(keys)]
      for (const key of uniqueKeys) {
        const listenersForBlock =
          blockListeners.get(key) ?? new Set<() => void>()
        listenersForBlock.add(listener)
        blockListeners.set(key, listenersForBlock)
      }

      return () => {
        for (const key of uniqueKeys) {
          const listenersForBlock = blockListeners.get(key)
          if (!listenersForBlock) continue
          listenersForBlock.delete(listener)
          if (listenersForBlock.size === 0) {
            blockListeners.delete(key)
          }
        }
      }
    },
  }
}

function useAssistantBlockGroups(store: AssistantBlockStore) {
  return React.useSyncExternalStore(
    store.subscribe,
    store.getGroups,
    store.getGroups
  )
}

function useAssistantBlock(store: AssistantBlockStore, key: string) {
  return React.useSyncExternalStore(
    (listener) => store.subscribeBlocks([key], listener),
    () => store.getBlock(key),
    () => store.getBlock(key)
  )
}

const EMPTY_TOOL_IMAGES: ConversationImage[] = []

type ToolBlockHeaderSnapshot = {
  name: string | undefined
  running: boolean
  isError: boolean
  summary: string
  /** The file of a read, write, or edit, for a link in the summary. */
  file: FileReference | null
  editStats: EditDiffStatCounts | null
  /** The counts of a finished test run in a shell call. */
  testCounts: { passed: number; failed: number } | null
  images: ConversationImage[]
  openStateKey: string
}

// One parse for each block: the header snapshot is built again on each
// update, and an unchanged block keeps its object.
const testCountsByBlock = new WeakMap<
  object,
  { passed: number; failed: number } | null
>()

function testCountsFromBlock(block: AssistantToolBlock) {
  if (testCountsByBlock.has(block)) return testCountsByBlock.get(block) ?? null
  const summary = parseTestSummary(block.output)
  const counts = summary
    ? { passed: summary.passed, failed: summary.failed }
    : null
  testCountsByBlock.set(block, counts)
  return counts
}

function sameEditDiffStatCounts(
  left: EditDiffStatCounts | null,
  right: EditDiffStatCounts | null
) {
  if (left === right) return true
  if (!left || !right) return false
  return left.additions === right.additions && left.removals === right.removals
}

function rememberedToolCollapsibleStateKey(
  block: AssistantConversationBlock | undefined,
  prefix = "tool"
) {
  if (!block) return `${prefix}:missing`

  if (block.type === "tool" && block.callId) {
    return `${prefix}:call:${block.callId}`
  }

  return `${prefix}:block:${
    block.renderKey || block.blockKey || assistantBlockKey(block)
  }`
}

function buildToolBlockHeaderSnapshot(
  block: AssistantConversationBlock | undefined
): ToolBlockHeaderSnapshot | null {
  if (!block || block.type !== "tool") return null

  return {
    name: block.name,
    running: block.running,
    isError: block.isError,
    summary: toolRenderer(block.name)?.summary?.(block) ?? toolSummary(block),
    file: block.running ? null : toolFileTarget(block),
    editStats:
      block.name === "edit" && !block.running
        ? getEditDiffStats(toolPatchText(block))
        : null,
    testCounts:
      block.name === "bash" && !block.running
        ? testCountsFromBlock(block)
        : null,
    // Custom renderers show their own result, images included, except
    // when they ask for the header images.
    images:
      toolRenderer(block.name) && !toolRenderer(block.name)?.showImages
        ? EMPTY_TOOL_IMAGES
        : (block.images ?? EMPTY_TOOL_IMAGES),
    openStateKey: rememberedToolCollapsibleStateKey(block),
  }
}

function sameToolBlockHeaderSnapshot(
  left: ToolBlockHeaderSnapshot | null,
  right: ToolBlockHeaderSnapshot | null
) {
  if (left === right) return true
  if (!left || !right) return false

  return (
    left.name === right.name &&
    left.running === right.running &&
    left.isError === right.isError &&
    left.summary === right.summary &&
    (left.file ? formatFileReference(left.file) : "") ===
      (right.file ? formatFileReference(right.file) : "") &&
    sameEditDiffStatCounts(left.editStats, right.editStats) &&
    left.testCounts?.passed === right.testCounts?.passed &&
    left.testCounts?.failed === right.testCounts?.failed &&
    sameConversationImages(left.images, right.images) &&
    left.openStateKey === right.openStateKey
  )
}

function useAssistantToolBlockHeader(store: AssistantBlockStore, key: string) {
  const cacheRef = React.useRef<ToolBlockHeaderSnapshot | null>(null)

  const getSnapshot = () => {
    const next = buildToolBlockHeaderSnapshot(store.getBlock(key))
    const cache = cacheRef.current
    if (sameToolBlockHeaderSnapshot(cache, next)) return cache

    cacheRef.current = next
    return next
  }

  return React.useSyncExternalStore(
    (listener) => store.subscribeBlocks([key], listener),
    getSnapshot,
    getSnapshot
  )
}

function useAssistantToolBlockBody(
  store: AssistantBlockStore,
  key: string,
  enabled: boolean
) {
  const getSnapshot = () => {
    if (!enabled) return undefined

    const block = store.getBlock(key)
    return block?.type === "tool" ? block : undefined
  }

  return React.useSyncExternalStore(
    (listener) => (enabled ? store.subscribeBlocks([key], listener) : () => {}),
    getSnapshot,
    getSnapshot
  )
}

function compactionTriggerText(
  block: Extract<ConversationItem, { kind: "assistant" }>["blocks"][number]
) {
  if (block.type !== "compaction") return "Compaction"
  if (block.tokensBefore <= 0) return "Compaction"

  return block.estimatedTokensAfter && block.estimatedTokensAfter > 0
    ? `Compaction: ${block.tokensBefore.toLocaleString()} → ~${block.estimatedTokensAfter.toLocaleString()} tokens`
    : `Compaction: Compacted from ${block.tokensBefore.toLocaleString()} tokens`
}

function getEditDiffStats(patch: string) {
  const stats = { additions: 0, removals: 0 }

  if (!patch) return stats

  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) stats.additions += 1
    if (line.startsWith("-")) stats.removals += 1
  }

  return stats
}

type EditDiffStatCounts = {
  additions: number
  removals: number
}

function EditDiffStatCountsView({ stats }: { stats: EditDiffStatCounts }) {
  if (!stats.additions && !stats.removals) return null

  return (
    <span
      className="flex shrink-0 items-center gap-2 font-mono text-sm"
      aria-label={`${stats.additions} lines added, ${stats.removals} lines removed`}
    >
      <span className="text-success">+{stats.additions}</span>
      <span className="text-destructive">−{stats.removals}</span>
    </span>
  )
}

function EditDiffBlock({
  isBorderless = false,
  patch,
}: {
  isBorderless?: boolean
  patch: string
}) {
  const themeOptions = useSmithDiffThemeOptions()

  return (
    <div
      className={cn(
        "overflow-hidden text-xs",
        !isBorderless && "rounded-md border bg-background"
      )}
      style={
        {
          "--diffs-font-family":
            'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace)',
        } as React.CSSProperties
      }
    >
      <PatchDiff
        patch={patch}
        disableWorkerPool
        options={{
          ...themeOptions,
          diffStyle: "unified",
          disableFileHeader: true,
          lineDiffType: "word-alt",
          maxLineDiffLength: 1000,
          overflow: "wrap",
        }}
      />
    </div>
  )
}

function PlainToolOutput({
  isError = false,
  linkBase,
  text,
}: {
  isError?: boolean
  /** Link the paths of the lines, relative to this folder ("" for cwd). */
  linkBase?: string
  text: string
}) {
  return (
    <pre
      className={cn(
        "overflow-x-auto font-mono text-xs leading-5 break-words whitespace-pre-wrap",
        isError && "text-destructive"
      )}
    >
      {linkBase !== undefined ? (
        <LinkifiedOutput text={text} base={linkBase} />
      ) : (
        text
      )}
    </pre>
  )
}

/** Tools whose output has paths: grep (`path:line:`) and file lists. */
const PATH_OUTPUT_TOOLS = new Set(["grep", "rg", "find", "glob", "ls", "list"])

/**
 * The folder that the paths in a tool's output are relative to, or
 * undefined when the output has no paths to link.
 */
function toolOutputLinkBase(block: AssistantToolBlock) {
  if (block.running || block.isError) return undefined
  if (block.name === "bash") return ""
  if (!block.name || !PATH_OUTPUT_TOOLS.has(block.name)) return undefined
  const path = getToolArgText(normalizeToolArgs(block.args), "path")
  return path === "." || path === "./" ? "" : path
}

// Colors in the output (ESC [ … m) keep their own renderer, without links.
const ANSI_ESCAPE = "\u001b"

function scrollDistanceFromBottom(element: HTMLElement) {
  return element.scrollHeight - element.clientHeight - element.scrollTop
}

function scrollElementToBottom(element: HTMLElement) {
  element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
}

function useRunningToolAutoScroll<
  TElement extends HTMLElement = HTMLDivElement,
>({ contentKey, enabled }: { contentKey: string; enabled: boolean }) {
  const scrollRef = React.useRef<TElement>(null)
  const autoScrollRef = React.useRef(true)
  const wasEnabledRef = React.useRef(false)

  React.useLayoutEffect(() => {
    const element = scrollRef.current

    if (!enabled) {
      wasEnabledRef.current = false
      return
    }

    if (!wasEnabledRef.current) {
      autoScrollRef.current = true
      wasEnabledRef.current = true
    }

    if (element && autoScrollRef.current) {
      scrollElementToBottom(element)
    }
  }, [contentKey, enabled])

  const handleScroll = (event: React.UIEvent<TElement>) => {
    if (!enabled) return

    const distance = scrollDistanceFromBottom(event.currentTarget)
    autoScrollRef.current = distance < 1
  }

  return { onScroll: handleScroll, ref: scrollRef }
}

const ToolBlockSection = React.memo(function ToolBlockSection({
  isError = false,
  label,
  linkBase,
  text,
}: {
  isError?: boolean
  label: string
  linkBase?: string
  text: string
}) {
  return (
    <section className="space-y-1.5">
      <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <PlainToolOutput isError={isError} linkBase={linkBase} text={text} />
    </section>
  )
})

function editToolOutputWithoutSuccessMessage(output: string) {
  return output
    .split("\n")
    .filter(
      (line) => !/^Successfully replaced \d+ block\(s\) in .+\.$/.test(line)
    )
    .join("\n")
    .trimEnd()
}

function writeToolOutputWithoutSuccessMessage(output: string) {
  return output
    .split("\n")
    .filter((line) => !/^Successfully wrote \d+ bytes to .+$/.test(line))
    .join("\n")
    .trimEnd()
}

const CODE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "c",
  cjs: "javascript",
  cpp: "c",
  css: "css",
  cxx: "c",
  go: "go",
  h: "c",
  htm: "html",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "jsonc",
  jsx: "jsx",
  mjs: "javascript",
  md: "markdown",
  mdx: "mdx",
  py: "python",
  rs: "rust",
  sh: "bash",
  ts: "typescript",
  tsx: "tsx",
  txt: "plaintext",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
} satisfies Record<string, string>

const CODE_LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
} satisfies Record<string, string>

function codeLanguageFromPath(filePath: string) {
  const fileName = filePath.replace(/\\/g, "/").split("/").pop()?.toLowerCase()
  if (!fileName) return undefined

  const filenameLanguage = CODE_LANGUAGE_BY_FILENAME[fileName]
  if (filenameLanguage) return filenameLanguage

  if (fileName.endsWith(".d.ts")) return "typescript"

  const extension = fileName.includes(".") ? fileName.split(".").pop() : ""
  return extension ? CODE_LANGUAGE_BY_EXTENSION[extension] : undefined
}

function WriteToolOutput({ block }: { block: AssistantToolBlock }) {
  const payload = getWriteToolPayload(block)
  const content = payload?.content
  const extraOutput = writeToolOutputWithoutSuccessMessage(
    block.output.trimEnd()
  )
  const autoScroll = useRunningToolAutoScroll<HTMLPreElement>({
    contentKey: content || "",
    enabled: block.running && content !== undefined,
  })

  if (block.isError) {
    return (
      <PlainToolOutput
        isError
        text={extraOutput || block.output.trimEnd() || "Write failed."}
      />
    )
  }

  if (!payload || content === undefined) {
    return (
      <PlainToolOutput
        text={toolOutputText(block) || "No content available."}
      />
    )
  }

  const language = payload.path ? codeLanguageFromPath(payload.path) : undefined

  return (
    <div className="space-y-3">
      <CodeBlock
        className="flex max-h-96 flex-col rounded-lg"
        code={content}
        language={language}
        onPreScroll={autoScroll.onScroll}
        preClassName="min-h-0 overflow-auto"
        preRef={autoScroll.ref}
        streaming={block.running}
      />
      {extraOutput ? (
        <PlainToolOutput isError={block.isError} text={extraOutput} />
      ) : null}
    </div>
  )
}

function EditToolOutput({
  block,
}: {
  block: Extract<ConversationItem, { kind: "assistant" }>["blocks"][number] & {
    type: "tool"
  }
}) {
  const patch = toolPatchText(block)
  const output = editToolOutputWithoutSuccessMessage(block.output.trimEnd())
  const extraOutput = output && output !== patch ? output : ""
  const fallbackOutput = editToolOutputWithoutSuccessMessage(
    toolOutputText(block)
  )
  const didSucceed = !block.running && !block.isError

  if (!patch) {
    return (
      <PlainToolOutput
        isError={block.isError}
        text={fallbackOutput || "No output available."}
      />
    )
  }

  return (
    <div className="space-y-3">
      <EditDiffBlock isBorderless={didSucceed} patch={patch} />
      {extraOutput ? (
        <PlainToolOutput isError={block.isError} text={extraOutput} />
      ) : null}
    </div>
  )
}

/** The body of an open tool card, from the store. */
function ToolBlockCardStoreBody({
  blockKey,
  store,
}: {
  blockKey: string
  store: AssistantBlockStore
}) {
  const block = useAssistantToolBlockBody(store, blockKey, true)
  return block ? <ToolBlockCardBody block={block} /> : null
}

function ToolBlockCardBody({ block }: { block: AssistantToolBlock }) {
  const CustomBody = toolRenderer(block.name)?.Body
  if (CustomBody) {
    return <CustomBody block={block} />
  }
  return <DefaultToolBlockCardBody block={block} />
}

/** The box of tool output that has no Code Block of its own. */
const TOOL_OUTPUT_BOX_CLASS =
  "max-h-96 overflow-auto rounded-lg border bg-background/80 p-3"

function DefaultToolBlockCardBody({ block }: { block: AssistantToolBlock }) {
  if (block.name === "bash") return <BashToolOutput block={block} />
  if (block.name === "write") {
    const selfContained =
      !block.isError && getWriteToolPayload(block)?.content !== undefined
    return selfContained ? (
      <WriteToolOutput block={block} />
    ) : (
      <div className={TOOL_OUTPUT_BOX_CLASS}>
        <WriteToolOutput block={block} />
      </div>
    )
  }
  if (block.name === "edit") {
    const isSuccessfulEdit = !block.running && !block.isError
    return (
      <div
        className={
          isSuccessfulEdit
            ? "max-h-96 overflow-auto rounded-lg border"
            : TOOL_OUTPUT_BOX_CLASS
        }
      >
        <EditToolOutput block={block} />
      </div>
    )
  }
  if (block.name === "read") {
    const code = readToolCode(block)
    if (code)
      return (
        <CodeBlock
          className="flex max-h-96 flex-col rounded-lg"
          code={code.text}
          language={code.language}
          preClassName="min-h-0 overflow-auto"
        />
      )
  }

  const callText = toolCallText(block)
  const sources =
    block.name === "web_search" && !block.running && !block.isError
      ? parseWebSources(block.output)
      : []
  return (
    <>
      {sources.length > 0 ? <Sources sources={sources} /> : null}
      <div className={cn(TOOL_OUTPUT_BOX_CLASS, "space-y-4")}>
        {callText ? <ToolBlockSection label="Call" text={callText} /> : null}
        <ToolBlockSection
          isError={block.isError}
          label={block.running ? "Output (streaming)" : "Output"}
          linkBase={toolOutputLinkBase(block)}
          text={toolOutputText(block)}
        />
      </div>
    </>
  )
}

/** A shell call as a Terminal: the command, then its output in color. */
function BashToolOutput({ block }: { block: AssistantToolBlock }) {
  const callText = toolCallText(block)
  const text =
    [callText, block.output.trimEnd()].filter(Boolean).join("\n\n") ||
    callText ||
    toolOutputText(block)
  const autoScroll = useRunningToolAutoScroll<HTMLPreElement>({
    contentKey: text,
    enabled: block.running,
  })
  const linkBase = toolOutputLinkBase(block)
  // Test runs and crashes get their own view above the output. Only a
  // finished call is read, once for each output.
  const output = block.running ? "" : block.output
  const testSummary = React.useMemo(
    () => (output ? parseTestSummary(output) : null),
    [output]
  )
  const stackTrace = React.useMemo(
    () => (output && block.isError ? parseStackTrace(output) : null),
    [output, block.isError]
  )

  return (
    <>
      {testSummary ? <TestResults summary={testSummary} /> : null}
      {stackTrace ? (
        <StackTrace trace={stackTrace} renderFile={renderStackFrameFile} />
      ) : null}
      <Terminal
        contentRef={autoScroll.ref}
        onScroll={autoScroll.onScroll}
        isError={block.isError}
      >
        {linkBase !== undefined && !text.includes(ANSI_ESCAPE) ? (
          <LinkifiedOutput text={text} />
        ) : (
          <AnsiText text={text} />
        )}
      </Terminal>
    </>
  )
}

/** The file of a stack frame, as a link to the file viewer. */
function renderStackFrameFile(frame: StackFrame) {
  if (!frame.file) return null
  const location = `${frame.file}${frame.line ? `:${frame.line}` : ""}${
    frame.column ? `:${frame.column}` : ""
  }`
  return (
    <FileLinkText
      reference={{
        path: frame.file,
        ...(frame.line ? { line: frame.line } : {}),
      }}
    >
      {location}
    </FileLinkText>
  )
}

/**
 * The code of a successful read, for a highlighted Code Block. Undefined
 * when the file type has no highlighter or the read returned no text.
 */
function readToolCode(block: AssistantToolBlock) {
  if (block.running || block.isError) return undefined
  const text = block.output.trimEnd()
  if (!text) return undefined
  const path = getToolArgText(normalizeToolArgs(block.args), "path")
  const language = path ? codeLanguageFromPath(path) : undefined
  return language ? { text, language } : undefined
}

const REMEMBERED_TOOL_COLLAPSIBLE_STATE_LIMIT = 500
const rememberedToolCollapsibleOpenKeys = new Map<string, true>()

function rememberToolCollapsibleOpenKey(key: string, open: boolean) {
  if (!key) return

  rememberedToolCollapsibleOpenKeys.delete(key)
  if (!open) return

  rememberedToolCollapsibleOpenKeys.set(key, true)
  while (
    rememberedToolCollapsibleOpenKeys.size >
    REMEMBERED_TOOL_COLLAPSIBLE_STATE_LIMIT
  ) {
    const oldestKey = rememberedToolCollapsibleOpenKeys.keys().next().value
    if (!oldestKey) break
    rememberedToolCollapsibleOpenKeys.delete(oldestKey)
  }
}

function useRememberedToolCollapsibleOpen(toolStateKey: string) {
  // Tool call IDs come from each machine, so the key holds the machine too.
  const openStateKey = `${useMachineId()}:${toolStateKey}`
  const [open, setOpenState] = React.useState(() =>
    rememberedToolCollapsibleOpenKeys.has(openStateKey)
  )

  React.useEffect(() => {
    setOpenState(rememberedToolCollapsibleOpenKeys.has(openStateKey))
  }, [openStateKey])

  const setOpen = (nextOpen: boolean) => {
    rememberToolCollapsibleOpenKey(openStateKey, nextOpen)
    setOpenState(nextOpen)
  }

  return [open, setOpen] as const
}

const ToolBlockCard = React.memo(function ToolBlockCard({
  blockKey,
  store,
}: {
  blockKey: string
  store: AssistantBlockStore
}) {
  const header = useAssistantToolBlockHeader(store, blockKey)

  if (!header) return null

  const CustomCard = toolRenderer(header.name)?.Card
  if (CustomCard) {
    return (
      <CustomToolBlockCard
        blockKey={blockKey}
        Card={CustomCard}
        header={header}
        store={store}
      />
    )
  }

  return (
    <ToolBlockCardContent blockKey={blockKey} header={header} store={store} />
  )
})

/** A tool card that a registered renderer draws, always open. */
function CustomToolBlockCard({
  blockKey,
  Card,
  header,
  store,
}: {
  blockKey: string
  Card: NonNullable<ReturnType<typeof toolRenderer>>["Card"] & {}
  header: ToolBlockHeaderSnapshot
  store: AssistantBlockStore
}) {
  const block = useAssistantToolBlockBody(store, blockKey, true)
  if (!block) return null
  return (
    <Card
      block={block}
      fallback={
        <ToolBlockCardContent
          blockKey={blockKey}
          header={header}
          store={store}
        />
      }
    />
  )
}

function ToolBlockCardContent({
  blockKey,
  header,
  store,
}: {
  blockKey: string
  header: ToolBlockHeaderSnapshot
  store: AssistantBlockStore
}) {
  const [isOpen, setIsOpen] = useRememberedToolCollapsibleOpen(
    header.openStateKey
  )

  return (
    <Tool open={isOpen} onOpenChange={setIsOpen}>
      <ToolHeader
        isError={header.isError}
        label={toolDisplayName(header.name)}
        running={header.running}
        summary={
          <ToolSummaryText summary={header.summary} file={header.file} />
        }
        summaryClassName={header.name === "write" ? "tabular-nums" : undefined}
      >
        {header.editStats ? (
          <EditDiffStatCountsView stats={header.editStats} />
        ) : header.testCounts ? (
          <TestResultsCounts summary={header.testCounts} />
        ) : null}
      </ToolHeader>
      {/* The panel unmounts its content when closed, after the close
          animation, so a closed row does not read its block. */}
      <ToolContent>
        <ToolBlockCardStoreBody blockKey={blockKey} store={store} />
      </ToolContent>
      <ToolResultImages images={header.images} />
    </Tool>
  )
}

const CompactionBlockCard = React.memo(function CompactionBlockCard({
  block,
}: {
  block: Extract<ConversationItem, { kind: "assistant" }>["blocks"][number] & {
    type: "compaction"
  }
}) {
  return (
    <TraceCollapsible className="rounded-xl border bg-muted/20 px-3 py-2">
      <TraceCollapsibleTrigger className="text-sm font-medium text-foreground">
        <span>{compactionTriggerText(block)}</span>
      </TraceCollapsibleTrigger>
      {/* A box with a divider, as before: no rail. */}
      <TraceCollapsibleContent rail={false} className="mt-3 border-t pt-3">
        {block.summary.trim() ? (
          <MarkdownBlock text={block.summary} />
        ) : (
          <div className="text-sm text-muted-foreground">
            No compaction summary available.
          </div>
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
})

/**
 * A user message, or a notice from another agent or a job (see
 * `lib/smith/agent-notice.ts`), which shows as a compact card.
 */
export const UserMessageCard = React.memo(function UserMessageCard({
  item,
}: {
  item: Extract<ConversationItem, { kind: "user" }>
}) {
  const notice = React.useMemo(
    () => (item.images.length > 0 ? null : parseAgentNotice(item.text)),
    [item.images.length, item.text]
  )
  if (notice) return <AgentNoticeCard item={item} notice={notice} />
  return <PromptMessageCard item={item} />
})

const NOTICE_TONE_CLASS: Record<AgentNoticeTone, string> = {
  default: "text-foreground/80",
  attention: "text-amber-600 dark:text-amber-400",
  muted: "text-muted-foreground/70",
  error: "text-destructive",
}

/**
 * The icon of a notice shows its state: a check when an agent is done, a
 * question mark when it asks, red when something failed. A job keeps the
 * terminal icon in the color of its result.
 */
function noticeIcon(notice: AgentNotice): {
  Icon: LucideIcon
  className: string
} {
  const color =
    notice.tone === "default" ? "text-success" : NOTICE_TONE_CLASS[notice.tone]
  if (notice.kind === "job")
    return { Icon: SquareTerminalIcon, className: color }
  if (notice.kind === "reminder")
    return { Icon: InfoIcon, className: NOTICE_TONE_CLASS.muted }
  if (notice.kind === "timer") return { Icon: AlarmClockIcon, className: color }
  if (notice.kind === "watch")
    return {
      Icon: notice.tone === "attention" ? TriangleAlertIcon : EyeIcon,
      className: color,
    }
  if (notice.state.startsWith("message"))
    return { Icon: MessageSquareIcon, className: "text-primary" }
  if (notice.tone === "attention")
    return {
      Icon:
        notice.state === "question"
          ? MessageCircleQuestionIcon
          : TriangleAlertIcon,
      className: color,
    }
  if (notice.tone === "error") return { Icon: CircleXIcon, className: color }
  if (notice.tone === "muted") return { Icon: CircleStopIcon, className: color }
  return { Icon: CircleCheckIcon, className: color }
}

/**
 * A notice as a collapsed row in the style of a tool card: the sender, its
 * state, and a summary. Open, it shows the body, the output of a job, and
 * the hint for the model.
 */
function AgentNoticeCard({
  item,
  notice,
}: {
  item: Extract<ConversationItem, { kind: "user" }>
  notice: AgentNotice
}) {
  const [isOpen, setIsOpen] = useRememberedToolCollapsibleOpen(
    `notice:${item.itemKey || item.forkEntryId || item.text.slice(0, 200)}`
  )
  const { Icon, className: iconClassName } = noticeIcon(notice)
  const agentId = notice.agentId

  return (
    // A light box sets notices apart from the tool and thinking lines.
    <TraceCollapsible
      data-conversation-row="true"
      data-agent-notice={notice.kind}
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn(
        "max-w-full rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5",
        isOpen ? "w-full" : "w-fit"
      )}
    >
      {/* The whole line is one hover and click target that opens the
          card. Only the agent link has its own hover. */}
      <div
        className="group/notice-row flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        onClick={(event) => {
          // The trigger and the agent link handle their own clicks.
          if ((event.target as HTMLElement).closest("button")) return
          setIsOpen(!isOpen)
        }}
      >
        <TraceCollapsibleTrigger
          data-conversation-tool-collapsible-trigger="true"
          className="shrink-0 text-inherit hover:text-inherit"
        >
          <TraceIcon>
            <Icon className={iconClassName} />
          </TraceIcon>
          <span className="font-medium whitespace-nowrap">{notice.label}</span>
        </TraceCollapsibleTrigger>
        {agentId && isLocalAgentId(agentId) ? (
          <TitleTooltip title={`Open agent ${agentId}`}>
            <button
              type="button"
              className="shrink-0 cursor-pointer rounded-sm font-medium whitespace-nowrap underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={() => emitSmithEvent("smith:open-agent", { agentId })}
            >
              {agentId}
            </button>
          </TitleTooltip>
        ) : agentId ? (
          <span className="shrink-0 font-medium whitespace-nowrap">
            {agentId}
          </span>
        ) : null}
        {/* The trigger above is the keyboard control. */}
        <span aria-hidden="true" className="flex min-w-0 items-center gap-1">
          <span className="shrink-0">·</span>
          <span
            className={cn(
              "shrink-0 font-medium whitespace-nowrap",
              NOTICE_TONE_CLASS[notice.tone]
            )}
          >
            {notice.state}
          </span>
          {notice.summary ? (
            <span className="ml-1 min-w-0 truncate text-foreground">
              {notice.summary}
            </span>
          ) : null}
        </span>
      </div>

      {/* The notice is a box, and its body has a box: no rail. */}
      <TraceCollapsibleContent rail={false}>
        <AgentNoticeBody notice={notice} copyText={item.text} />
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

function AgentNoticeBody({
  copyText,
  notice,
}: {
  copyText: string
  notice: AgentNotice
}) {
  return (
    <div>
      <div className="max-h-96 space-y-3 overflow-auto rounded-lg border bg-background/80 p-3">
        {notice.markdown ? (
          notice.body.trim() ? (
            <MarkdownBlock text={notice.body} />
          ) : null
        ) : notice.body ? (
          <PlainToolOutput text={notice.body} />
        ) : null}
        {notice.command ? (
          <ToolBlockSection
            label={notice.kind === "watch" ? "Checked" : "Command"}
            text={notice.command}
          />
        ) : null}
        {notice.output !== undefined ? (
          <ToolBlockSection
            label={notice.kind === "watch" ? "Last check" : "Last output"}
            text={notice.output}
          />
        ) : null}
        {notice.hint ? (
          <p className="text-xs text-muted-foreground">{notice.hint}</p>
        ) : null}
      </div>
      <div className="mt-1 flex gap-1.5">
        <MessageFooterCopyButton idleLabel="Copy message" text={copyText} />
      </div>
    </div>
  )
}

/**
 * The tail of a message bubble, as in Messages: a short point that leaves
 * the bottom edge and turns out below the bottom right corner. It fills the
 * corner, so the bubble and the tail are one shape. Its box is 24×18 px; the
 * bubble's bottom edge is at y=10. It is traced for a round 22px corner, so
 * the bubble keeps that radius (not a theme radius, which can scale).
 */
function BubbleTail() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 18"
      className="pointer-events-none absolute right-0 -bottom-2 h-4.5 w-6 text-primary"
    >
      <path
        fill="currentColor"
        d="M0 0H20.4C18.6 2.9 16.2 5.3 13.9 7C12.6 8 12.3 9.3 12.4 10.6C12.5 12.6 13.6 14 14.6 15.6C15.4 16.9 14.6 17.6 13.2 17.2L0 9.8Z"
      />
    </svg>
  )
}

function PromptMessageCard({
  item,
}: {
  item: Extract<ConversationItem, { kind: "user" }>
}) {
  const labelText = userMessageLabel(item)
  const imageSrc = useConversationImageSrc()
  const [selectedImageIndex, setSelectedImageIndex] = React.useState<
    number | null
  >(null)
  const selectedImage =
    selectedImageIndex === null
      ? null
      : (item.images[selectedImageIndex] ?? null)

  return (
    <Message align="end" className="text-[length:inherit]">
      <MessageContent className="gap-0">
        <Bubble className="mr-2 max-w-[calc(100%-0.5rem)] sm:max-w-[80%]">
          <BubbleContent className="overflow-visible rounded-[22px] border-0 px-5 py-2.5 text-[length:inherit] leading-[inherit] corner-round">
            {labelText ? (
              <div className="mb-2 flex items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-primary-foreground/35 bg-primary-foreground/10 text-primary-foreground"
                >
                  {labelText}
                </Badge>
              </div>
            ) : null}
            {item.text ? (
              <CollapsibleUserText>
                <MarkdownBlock
                  breaks
                  text={item.text}
                  className="user-markdown"
                />
              </CollapsibleUserText>
            ) : (
              <div className="text-sm text-primary-foreground/80">
                Image prompt
              </div>
            )}
            {item.images.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-3">
                {item.images.map((image, index) => (
                  <button
                    key={`${image.url}:${index}`}
                    type="button"
                    className="max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-primary-foreground/20 bg-primary-foreground/10 p-0 transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary-foreground/70 focus-visible:ring-offset-2 focus-visible:ring-offset-primary focus-visible:outline-none"
                    onClick={() => setSelectedImageIndex(index)}
                  >
                    <img
                      src={imageSrc(image)}
                      alt="Prompt upload"
                      loading="lazy"
                      decoding="async"
                      className="block h-28 max-w-full object-cover"
                    />
                    <span className="sr-only">Open prompt upload</span>
                  </button>
                ))}
              </div>
            ) : null}
          </BubbleContent>
          <BubbleTail />
        </Bubble>
        <UserMessageFooter copyText={item.text} entryId={item.forkEntryId} />
      </MessageContent>
      {selectedImage ? (
        <ImageLightbox
          open={true}
          onOpenChange={(open) => {
            if (!open) setSelectedImageIndex(null)
          }}
          imageSrc={imageSrc(selectedImage)}
          imageAlt="Prompt upload"
          index={selectedImageIndex ?? 0}
          count={item.images.length}
          onIndexChange={setSelectedImageIndex}
          title="Prompt upload preview"
          description="Expanded preview of an image attached to a user message."
        />
      ) : null}
    </Message>
  )
}

/** Height in px above which a user message folds behind Read more. */
const USER_MESSAGE_COLLAPSED_HEIGHT = 320

function CollapsibleUserText({ children }: { children: React.ReactNode }) {
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const [overflows, setOverflows] = React.useState(false)
  const [expanded, setExpanded] = React.useState(false)

  React.useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    const measure = () => {
      // Fold only when it hides a useful part, not a line or two.
      setOverflows(content.offsetHeight > USER_MESSAGE_COLLAPSED_HEIGHT + 80)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  const collapsed = overflows && !expanded

  return (
    <>
      <div
        className={cn(
          collapsed && "overflow-hidden mask-b-from-60% mask-b-to-100%"
        )}
        style={
          collapsed ? { maxHeight: USER_MESSAGE_COLLAPSED_HEIGHT } : undefined
        }
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {overflows ? (
        <button
          type="button"
          className="mt-1 mb-1 rounded-sm text-sm font-medium text-primary-foreground/90 underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary-foreground/70 focus-visible:outline-none"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      ) : null}
    </>
  )
}

export type UserMessageActions = {
  /** Fork at the message's parent and put its text back in the composer. */
  editUserMessage?: (entryId: string) => void
  /** True while the agent works; the server refuses tree moves then. */
  editDisabled?: boolean
}

export const UserMessageActionsContext =
  React.createContext<UserMessageActions>({})

function UserMessageFooter({
  copyText,
  entryId,
}: {
  copyText: string
  entryId?: string
}) {
  const { editUserMessage, editDisabled } = React.useContext(
    UserMessageActionsContext
  )
  const canEdit = Boolean(entryId && editUserMessage)
  if (!copyText.trim() && !canEdit) return null

  return (
    // Left of the bubble's tail and close under the bubble, in the corner
    // that the tail leaves free.
    <MessageFooter className="-mt-0.5 mr-7 gap-1 px-0">
      {canEdit && entryId && editUserMessage ? (
        <TitleTooltip
          title={
            editDisabled
              ? "Wait for the agent to finish to edit"
              : "Edit and resend from here"
          }
        >
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            disabled={editDisabled}
            aria-label="Edit user message"
            onClick={() => editUserMessage(entryId)}
          >
            <PencilIcon />
          </Button>
        </TitleTooltip>
      ) : null}
      {copyText.trim() ? (
        <MessageFooterCopyButton
          idleLabel="Copy user message"
          text={copyText}
        />
      ) : null}
    </MessageFooter>
  )
}

export function assistantMessageHasVisibleBlocks({
  item,
  hideThinking,
  hideToolBlocks,
}: {
  item: Extract<ConversationItem, { kind: "assistant" }>
  hideThinking: boolean
  hideToolBlocks: boolean
}) {
  return item.blocks.some((block) =>
    assistantBlockIsVisible({ block, hideThinking, hideToolBlocks })
  )
}

export function assistantMessageHasFooterMeta(
  item: Extract<ConversationItem, { kind: "assistant" }>
) {
  return Boolean(item.model || assistantCopyTextFromItems([item]))
}

const AssistantBlockGroupView = React.memo(function AssistantBlockGroupView({
  descriptor,
  hideThinking,
  isLast,
  store,
  streaming,
}: {
  descriptor: AssistantBlockDescriptor
  hideThinking: boolean
  /** The last block of the message: it is the one that streams. */
  isLast: boolean
  store: AssistantBlockStore
  streaming: boolean
}) {
  const blockView = (
    <AssistantSingleBlockGroupView
      blockKey={descriptor.key}
      blockType={descriptor.blockType}
      hideThinking={hideThinking}
      isLast={isLast}
      store={store}
      streaming={streaming}
    />
  )

  const blockProps = {
    "data-conversation-assistant-block": "true",
    "data-conversation-assistant-block-key": descriptor.key,
    "data-conversation-assistant-block-type": descriptor.blockType,
  }

  return <div {...blockProps}>{blockView}</div>
})

function AssistantSingleBlockGroupView({
  blockKey,
  blockType,
  hideThinking,
  isLast,
  store,
  streaming,
}: {
  blockKey: string
  blockType: AssistantConversationBlock["type"]
  hideThinking: boolean
  isLast: boolean
  store: AssistantBlockStore
  streaming: boolean
}) {
  if (blockType === "tool") {
    return <ToolBlockCard blockKey={blockKey} store={store} />
  }

  if (blockType === "thinking" && hideThinking) {
    return (
      <CollapsedThinkingBlock
        blockKey={blockKey}
        isLast={isLast}
        store={store}
        streaming={streaming}
      />
    )
  }

  return (
    <AssistantSubscribedBlockView
      blockKey={blockKey}
      blockType={blockType}
      store={store}
      streaming={streaming}
    />
  )
}

function ThinkingBlockBody({
  streaming,
  text,
}: {
  streaming: boolean
  text: string
}) {
  return (
    <ReasoningText>
      <MarkdownBlock text={text} streaming={streaming} />
    </ReasoningText>
  )
}

function useThinkingBlockLabel(store: AssistantBlockStore, key: string) {
  const getSnapshot = () => {
    const block = store.getBlock(key)
    return (block?.type === "thinking" && block.summaryLabel?.trim()) || ""
  }

  return React.useSyncExternalStore(
    (listener) => store.subscribeBlocks([key], listener),
    getSnapshot,
    getSnapshot
  )
}

/** The text of an open hidden thinking block. It subscribes to the text. */
function OpenThinkingBlockBody({
  blockKey,
  store,
  streaming,
}: {
  blockKey: string
  store: AssistantBlockStore
  streaming: boolean
}) {
  const block = useAssistantBlock(store, blockKey)
  if (block?.type !== "thinking") return null

  // The rail of the Reasoning content takes the place of the amber rail.
  return <MarkdownBlock text={block.text} streaming={streaming} />
}

/**
 * Hidden thinking: one line of muted text that opens the thinking block.
 * Each block opens alone, and the open state stays when the view renders
 * again. A closed row reads only the label, so streamed thinking text does
 * not render it again.
 */
function CollapsedThinkingBlock({
  blockKey,
  isLast,
  store,
  streaming,
}: {
  blockKey: string
  isLast: boolean
  store: AssistantBlockStore
  streaming: boolean
}) {
  const label = useThinkingBlockLabel(store, blockKey)
  const [isOpen, setIsOpen] = useRememberedToolCollapsibleOpen(
    `thinking:${blockKey}`
  )

  return (
    <Reasoning open={isOpen} onOpenChange={setIsOpen}>
      <ReasoningTrigger
        label={label || "Thinking"}
        // Only the thinking that streams now shimmers.
        streaming={streaming && isLast}
      />
      <TraceCollapsibleContent>
        <OpenThinkingBlockBody
          blockKey={blockKey}
          store={store}
          streaming={streaming}
        />
      </TraceCollapsibleContent>
    </Reasoning>
  )
}

function AssistantSubscribedBlockView({
  blockKey,
  blockType,
  store,
  streaming,
}: {
  blockKey: string
  blockType: AssistantConversationBlock["type"]
  store: AssistantBlockStore
  streaming: boolean
}) {
  const block = useAssistantBlock(store, blockKey)
  if (!block || block.type !== blockType) return null

  switch (block.type) {
    case "text":
      return block.isError ? (
        <div className="text-sm leading-6 wrap-break-word whitespace-pre-wrap text-destructive">
          {block.text}
        </div>
      ) : (
        <MarkdownBlock text={block.text} streaming={streaming} />
      )
    case "thinking":
      return <ThinkingBlockBody text={block.text} streaming={streaming} />
    case "compaction":
      return <CompactionBlockCard block={block} />
    default:
      return null
  }
}

// Rows of collapsed tools and thinking sit closer together.
const COMPACT_ROWS_CLASS =
  "[&>*:has(>[data-conversation-row])+*:has(>[data-conversation-row])]:-mt-2"

/**
 * The index of the first group of the final answer: the text blocks at the
 * end. -1 when there is no answer, or nothing before it.
 */
function finalAnswerStartIndex(groups: Array<AssistantBlockDescriptor>) {
  let index = groups.length
  while (index > 0) {
    const group = groups[index - 1]
    if (group?.blockType !== "text") break
    index -= 1
  }
  return index > 0 && index < groups.length ? index : -1
}

/** The work before the final answer, in one collapsed row. */
function AssistantWorkGroup({
  children,
  label,
  openStateKey,
}: {
  children: React.ReactNode
  label: string
  openStateKey: string
}) {
  const [isOpen, setIsOpen] = useRememberedToolCollapsibleOpen(openStateKey)

  return (
    <div
      data-conversation-assistant-block="true"
      data-conversation-assistant-block-type="work"
    >
      <ChainOfThought open={isOpen} onOpenChange={setIsOpen}>
        <ChainOfThoughtHeader label={label} />
        <ChainOfThoughtContent>
          <div className={cn("flex flex-col gap-4", COMPACT_ROWS_CLASS)}>
            {children}
          </div>
        </ChainOfThoughtContent>
      </ChainOfThought>
    </div>
  )
}

function AssistantBlockGroupsView({
  hideThinking,
  store,
  streaming,
  workLabel,
}: {
  hideThinking: boolean
  store: AssistantBlockStore
  streaming: boolean
  workLabel: string
}) {
  const renderedBlocks = useAssistantBlockGroups(store)
  const answerStart = workLabel ? finalAnswerStartIndex(renderedBlocks) : -1
  const workGroups = answerStart > 0 ? renderedBlocks.slice(0, answerStart) : []

  const lastGroup = renderedBlocks.at(-1)
  const renderGroup = (descriptor: AssistantBlockDescriptor) => (
    <AssistantBlockGroupView
      key={descriptor.key}
      descriptor={descriptor}
      hideThinking={hideThinking}
      isLast={descriptor === lastGroup}
      store={store}
      streaming={streaming}
    />
  )

  if (workGroups.length === 0) return <>{renderedBlocks.map(renderGroup)}</>

  return (
    <>
      <AssistantWorkGroup
        label={workLabel}
        openStateKey={`work:${workGroups[0]!.key}`}
      >
        {workGroups.map(renderGroup)}
      </AssistantWorkGroup>
      {renderedBlocks.slice(answerStart).map(renderGroup)}
    </>
  )
}

function MessageFooterCopyButton({
  className,
  idleLabel,
  text,
}: {
  className?: string
  idleLabel: string
  text: string
}) {
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "error">(
    "idle"
  )
  const canCopy = Boolean(text.trim())

  const copyMessage = async () => {
    if (!canCopy) return

    try {
      await copyTextToClipboard(text)
      setCopyState("copied")
      window.setTimeout(() => setCopyState("idle"), 1400)
    } catch {
      setCopyState("error")
      window.setTimeout(() => setCopyState("idle"), 1400)
    }
  }

  const label =
    copyState === "copied"
      ? "Copied"
      : copyState === "error"
        ? "Retry copy"
        : idleLabel

  return (
    <TitleTooltip title={label}>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn("text-muted-foreground", className)}
        disabled={!canCopy}
        aria-label={label}
        onClick={copyMessage}
      >
        {copyState === "copied" ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </TitleTooltip>
  )
}

function AssistantMessageFooter({
  copyText,
  modelLabel,
  streaming,
}: {
  copyText: string
  modelLabel: string
  streaming: boolean
}) {
  if (streaming) return null

  const showCopyButton = Boolean(copyText.trim())

  if (!showCopyButton && !modelLabel) return null

  return (
    <MessageFooter className="-mt-2 gap-1.5 px-0">
      {showCopyButton ? (
        <MessageFooterCopyButton
          className="-ml-2"
          idleLabel="Copy assistant message"
          text={copyText}
        />
      ) : null}
      {modelLabel ? <span className="truncate">{modelLabel}</span> : null}
    </MessageFooter>
  )
}

export function AssistantMessagesStoreCard({
  className,
  hideFooter = false,
  store,
}: {
  className?: string
  hideFooter?: boolean
  store: AssistantMessagesStore
}) {
  const [{ assistantBlockStore, shellStore }] = React.useState<{
    assistantBlockStore: AssistantBlockStore
    shellStore: AssistantMessagesShellStore
  }>(() => {
    const initialSnapshot = store.getSnapshot()
    const initialBlocks = visibleAssistantBlocksFromSnapshot(initialSnapshot)
    return {
      assistantBlockStore: createAssistantBlockStore(initialBlocks),
      shellStore: createAssistantMessagesShellStore(
        assistantMessagesShellSnapshotFromBlocks(initialSnapshot, initialBlocks)
      ),
    }
  })

  React.useLayoutEffect(() => {
    const applySnapshot = () => {
      const snapshot = store.getSnapshot()
      const blocks = visibleAssistantBlocksFromSnapshot(snapshot)
      assistantBlockStore.setBlocks(blocks)
      shellStore.setSnapshot(
        assistantMessagesShellSnapshotFromBlocks(snapshot, blocks)
      )
    }

    applySnapshot()
    return store.subscribe(applySnapshot)
  }, [assistantBlockStore, shellStore, store])

  const shellSnapshot = React.useSyncExternalStore(
    shellStore.subscribe,
    shellStore.getSnapshot,
    shellStore.getSnapshot
  )

  const showFooter = Boolean(
    !hideFooter && !shellSnapshot.working && shellSnapshot.hasFooter
  )

  if (!shellSnapshot.hasBlocks && !showFooter) {
    return null
  }

  return (
    <Message
      // Text sizes come from the blocks, as before the Message.
      className={cn("text-[length:inherit]", className)}
      data-conversation-assistant-group="true"
      data-conversation-streaming={shellSnapshot.streaming ? "true" : undefined}
    >
      <MessageContent className={cn("gap-4", COMPACT_ROWS_CLASS)}>
        {shellSnapshot.hasBlocks ? (
          <AssistantBlockGroupsView
            hideThinking={shellSnapshot.hideThinking}
            store={assistantBlockStore}
            streaming={shellSnapshot.streaming}
            workLabel={shellSnapshot.workLabel}
          />
        ) : null}
        {showFooter ? (
          <AssistantMessageFooter
            copyText={shellSnapshot.copyText}
            modelLabel={shellSnapshot.modelLabel}
            streaming={shellSnapshot.streaming}
          />
        ) : null}
      </MessageContent>
    </Message>
  )
}
