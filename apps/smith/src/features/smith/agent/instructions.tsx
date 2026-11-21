import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronRightIcon, FileTextIcon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TitleTooltip } from "@/components/ui/tooltip"
import {
  registerAgentSection,
  type AgentSectionProps,
} from "@/features/smith/agent/agent-panel"
import { useProfiles } from "@/features/smith/agent/profiles"
import { TextDialog } from "@/features/smith/agent/shared"
import { buildRequestUrl, fetchJson } from "@/features/smith/app-shell-utils"
import { useMachineId } from "@/lib/smith/machine-context"
import { useSmithEvent } from "@/features/smith/agent/events"
import {
  formatTokens,
  partColor,
  estimateNote,
  summaryLines,
  shareWidths,
  TOOLS_COLOR,
  type PromptTokens,
  type TokenCount,
} from "@/features/smith/agent/prompt-tokens"
import { cn } from "@/lib/utils"

/** The context files (AGENTS.md) that the agent loads. */
type Instructions = { cwd: string; files: Array<{ path: string }> }

/** One section of the system prompt, from `/api/agent/system-prompt`. */
type PromptSection = {
  id: string
  extension?: string
  title: string
  source?: string
  files?: Array<{ path: string; scope: "global" | "project" }>
  text: string
  tagged: boolean
}

type SystemPrompt = {
  cwd: string
  sent: boolean
  updates: number
  sections: PromptSection[]
  text: string
  tokens?: PromptTokens
}

/** One line of the ordered list: a section, or a part of one. */
type Part = {
  key: string
  section: PromptSection
  title: string
  description: string
  files: string[]
}

const SYSTEM_PROMPT_PATH = "/api/agent/system-prompt"
const TOKENS_PATH = "/api/agent/system-prompt/tokens"
const PREVIEW_PATH = "/api/agent/system-prompt/preview"

function instructionsOf(state: Record<string, unknown>) {
  const value = state.instructions as Instructions | undefined
  return value && Array.isArray(value.files) ? value : undefined
}

/** The last name of a folder path. */
function folderName(path: string) {
  return path.replace(/\/+$/, "").split("/").pop() || path
}

/** The path from the agent folder, for a file inside it. */
function relativePath(path: string, cwd: string) {
  const root = cwd.replace(/\/+$/, "")
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined
}

/**
 * A short label: the path from the agent folder (`../AGENTS.md` for a file
 * in a parent folder), or the full path.
 */
function labelOf(path: string, cwd: string) {
  const relative = relativePath(path, cwd)
  if (relative) return relative
  const slash = path.lastIndexOf("/")
  const folder = path.slice(0, slash)
  const root = cwd.replace(/\/+$/, "")
  if (folder && root.startsWith(`${folder}/`)) {
    const depth = root.slice(folder.length + 1).split("/").length
    return `${"../".repeat(depth)}${path.slice(slash + 1)}`
  }
  return path.replace(/^\/home\/[^/]+(?=\/)|^\/Users\/[^/]+(?=\/)/, "~")
}

/** What a section is, in one line. */
function describe(section: PromptSection) {
  switch (section.id) {
    case "preamble":
      return section.source ? "Your SYSTEM.md" : "Smith's base prompt"
    case "rules":
      return "Tool usage guidelines from the enabled tools"
    case "addendum":
      return "Your APPEND_SYSTEM.md, added to the base prompt"
    case "skills":
      return "Skills the agent can load when a task matches"
    case "cwd":
      return "The folder the agent works in"
    case "instructions":
      return "Instructions for this agent from its profile or parent"
    case "codemode":
      return "Tools that scripts can call"
    case "todo":
      return "The open items of the agent's todo list"
    case "project_jobs":
      return "Background jobs of other agents in this project"
    case "system":
      return "Text outside the sections"
    default:
      return section.extension
        ? `Added by the ${section.extension} extension`
        : "Added by an extension"
  }
}

/**
 * The lines of the ordered list. The project context section holds the
 * global and the project AGENTS.md files, so it gets one line for each.
 */
function partsOf(sections: PromptSection[]): Part[] {
  const parts: Part[] = []
  for (const section of sections) {
    if (section.id === "project_context") {
      const files = section.files ?? []
      const global = files.filter((file) => file.scope === "global")
      const project = files.filter((file) => file.scope === "project")
      if (global.length > 0)
        parts.push({
          key: "project_context:global",
          section,
          title: "Global instructions",
          description: "Your AGENTS.md for every project",
          files: global.map((file) => file.path),
        })
      if (project.length > 0 || global.length === 0)
        parts.push({
          key: "project_context:project",
          section,
          title: "Project instructions",
          description: "AGENTS.md files from the repo root down to the folder",
          files: project.map((file) => file.path),
        })
      continue
    }
    parts.push({
      key: section.id,
      section,
      title: section.title,
      description: describe(section),
      files: section.source ? [section.source] : [],
    })
  }
  return parts
}

/**
 * Where the prompt comes from: the agent, or, for a new agent before its
 * first prompt, a preview of what it would get.
 */
type PromptSource = {
  path: string
  tokensPath: string
  agentId: string
  searchParams: Record<string, string>
  /** The folder of a preview. */
  preview?: string
}

function sourceOf(
  { agentId, draft }: Pick<AgentSectionProps, "agentId" | "draft">,
  profile: string | undefined
): PromptSource {
  if (!draft)
    return {
      path: SYSTEM_PROMPT_PATH,
      tokensPath: TOKENS_PATH,
      agentId,
      searchParams: {},
    }
  return {
    path: PREVIEW_PATH,
    tokensPath: `${PREVIEW_PATH}/tokens`,
    agentId: "",
    searchParams: {
      cwd: draft.cwd,
      ...(profile ? { profile } : {}),
      ...(draft.model ? { model: draft.model } : {}),
    },
    preview: draft.cwd,
  }
}

/** The source of the section's prompt; a preview follows the draft's profile. */
function usePromptSource(
  props: Pick<AgentSectionProps, "agentId" | "draft" | "viewerContextId">
) {
  // The profile of the draft, as the profile menu of the composer sets it.
  const profiles = useProfiles(
    props.viewerContextId,
    undefined,
    Boolean(props.draft)
  )
  return sourceOf(
    props,
    props.draft ? (profiles.data?.current ?? "full") : undefined
  )
}

/** The data of the section: the prompt, and its exact counts when they come. */
function useSystemPrompt(source: PromptSource, viewerContextId: string) {
  const machineId = useMachineId()
  const { agentId, searchParams } = source
  const query = useQuery({
    queryKey: [
      "smith",
      "system-prompt",
      viewerContextId,
      agentId,
      source.path,
      searchParams,
    ],
    queryFn: () =>
      fetchJson<SystemPrompt>(
        buildRequestUrl(source.path, {
          machineId,
          contextId: viewerContextId,
          agentId,
          searchParams,
        })
      ),
  })
  // Exact counts that the server did not have yet: one more request, which
  // waits for them.
  const pending = query.data?.tokens?.pending === true
  const exactQuery = useQuery({
    queryKey: [
      "smith",
      "system-prompt-tokens",
      viewerContextId,
      agentId,
      source.tokensPath,
      searchParams,
      query.dataUpdatedAt,
    ],
    enabled: pending,
    retry: false,
    queryFn: () =>
      fetchJson<{ tokens: PromptTokens }>(
        buildRequestUrl(source.tokensPath, {
          machineId,
          contextId: viewerContextId,
          agentId,
          searchParams,
        })
      ),
  })
  // The server tells when the agent gets a new or changed system prompt.
  useSmithEvent("smith:agent-extensions", (detail) => {
    if (
      agentId &&
      detail.agentId === agentId &&
      detail.kind === "system_prompt"
    )
      void query.refetch()
  })
  const tokens =
    (pending ? exactQuery.data?.tokens : undefined) ?? query.data?.tokens
  return { query, prompt: query.data, tokens }
}

/** The total in the section header, with the share of the context window. */
function InstructionsSummary(props: AgentSectionProps) {
  const source = usePromptSource(props)
  const { tokens } = useSystemPrompt(source, props.viewerContextId)
  if (!tokens) {
    // Until the counts load, or from an older server: the files.
    const count = instructionsOf(props.state)?.files.length ?? 0
    return count > 0
      ? `${count} ${count === 1 ? "file" : "files"}`
      : "System prompt"
  }
  const text = `${formatTokens(tokens.total)} tokens`
  const lines = summaryLines(tokens)
  if (lines.length === 0) return text
  return (
    <TitleTooltip
      title={
        <span className="flex max-w-64 flex-col gap-1">
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      }
    >
      <span>{text}</span>
    </TitleTooltip>
  )
}

/** One part of the share bar. */
type Segment = {
  key: string
  label: string
  tokens: number
  exact: boolean
  color: string
}

/**
 * One thin bar with a colored part for each count, as in Storage. Each part
 * names its count in a tooltip; a taller, clear hit area makes it easy to hover.
 */
function ShareBar({ segments }: { segments: Segment[] }) {
  const widths = shareWidths(segments.map((segment) => segment.tokens))
  if (!widths.some((width) => width > 0)) return null
  const total = segments.reduce((sum, segment) => sum + segment.tokens, 0)
  return (
    <div aria-hidden="true" className="mx-1.5 flex gap-px">
      {segments.map((segment, index) =>
        widths[index] > 0 ? (
          <TitleTooltip
            key={segment.key}
            title={`${segment.label} · ${formatTokens({ tokens: segment.tokens, exact: segment.exact })} · ${Math.max(1, Math.round((segment.tokens / total) * 100))}%`}
          >
            <span
              className="group/segment flex min-w-0 py-1"
              style={{ flex: `${widths[index]} 1 0%` }}
            >
              <span
                className={cn(
                  "h-1.5 w-full transition-[filter] group-first/segment:rounded-l-full group-last/segment:rounded-r-full group-hover/segment:brightness-125",
                  segment.color
                )}
              />
            </span>
          </TitleTooltip>
        ) : null
      )}
    </div>
  )
}

/** A small uppercase header with the total of its group at the right. */
function GroupHeader({
  title,
  count,
}: {
  title: string
  count: TokenCount | undefined
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-1.5 pb-0.5 text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase">
      <span>{title}</span>
      {count ? (
        <span className="normal-case tabular-nums">{formatTokens(count)}</span>
      ) : null}
    </div>
  )
}

function GroupFooter({ children }: { children: React.ReactNode }) {
  return <p className="px-1.5 pt-1 text-xs text-muted-foreground">{children}</p>
}

const ROW_CLASS =
  "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none"

/**
 * One line of a group: color dot, name, muted suffix, count, and a chevron
 * when it opens something.
 */
function Row({
  color,
  name,
  suffix,
  count,
  label,
  onClick,
}: {
  color?: string
  name: string
  suffix?: string
  count?: TokenCount
  label?: string
  onClick?: () => void
}) {
  const content = (
    <>
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", color)}
      />
      <span className="flex min-w-0 flex-1 items-baseline gap-1">
        {/* The suffix gets cut off first, then the name. */}
        <span className="max-w-full shrink-0 truncate">{name}</span>
        {suffix ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            · {suffix}
          </span>
        ) : null}
      </span>
      {count ? (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatTokens(count)}
        </span>
      ) : null}
      <ChevronRightIcon
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground",
          !onClick && "invisible"
        )}
      />
    </>
  )
  return (
    <li>
      {onClick ? (
        <button
          type="button"
          aria-label={label}
          className={cn(
            ROW_CLASS,
            "hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
          )}
          onClick={onClick}
        >
          {content}
        </button>
      ) : (
        <div className={ROW_CLASS}>{content}</div>
      )}
    </li>
  )
}

/** The tool definitions that each request sends, with their counts. */
function ToolsDialog({
  tokens,
  onOpenChange,
}: {
  tokens: PromptTokens
  onOpenChange: (open: boolean) => void
}) {
  const { items } = tokens.tools
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tools ({items.length})</DialogTitle>
          <DialogDescription>
            The name, description, and input schema of each tool. Each request
            sends them.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-[60vh] overflow-auto rounded-md border p-1">
          {items.map((tool) => (
            <li
              key={tool.name}
              className="flex h-7 min-w-0 items-center gap-2 px-1.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {tool.name}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatTokens(tool)}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

/** The tools group: the tool definitions and the overhead of tool use. */
function ToolsGroup({ tokens }: { tokens: PromptTokens }) {
  const [open, setOpen] = React.useState(false)
  const { items, overhead, total } = tokens.tools
  if (items.length === 0) return null
  const shownOverhead = overhead && overhead.tokens > 0 ? overhead : undefined
  const listed = shownOverhead
    ? { tokens: total.tokens - shownOverhead.tokens, exact: total.exact }
    : total
  return (
    <section aria-label="Tools">
      <GroupHeader title="Tools" count={total} />
      <ul>
        <Row
          color={TOOLS_COLOR}
          name={`Tools (${items.length})`}
          count={listed}
          label={`Show the ${items.length} tools`}
          onClick={() => setOpen(true)}
        />
        {shownOverhead ? (
          <Row
            color={cn(TOOLS_COLOR, "opacity-50")}
            name="Tool use overhead"
            count={shownOverhead}
          />
        ) : null}
      </ul>
      {open ? <ToolsDialog tokens={tokens} onOpenChange={setOpen} /> : null}
    </section>
  )
}

/** A short list of files under a title in a dialog header. */
function FileLinks({
  files,
  cwd,
  onOpen,
}: {
  files: string[]
  cwd: string
  onOpen: (path: string) => void
}) {
  return files.map((path) => (
    <TitleTooltip key={path} title={path}>
      <button
        type="button"
        aria-label={`Show ${path}`}
        className="inline-flex min-w-0 items-center gap-1 rounded-sm text-xs text-muted-foreground underline-offset-3 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={() => onOpen(path)}
      >
        <FileTextIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{labelOf(path, cwd)}</span>
      </button>
    </TitleTooltip>
  ))
}

function FileRow({
  path,
  cwd,
  onOpen,
}: {
  path: string
  cwd: string
  onOpen: (path: string) => void
}) {
  return (
    <TitleTooltip title={path}>
      <button
        type="button"
        aria-label={`Show ${path}`}
        className={cn(
          ROW_CLASS,
          "hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
        )}
        onClick={() => onOpen(path)}
      >
        <FileTextIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate">{labelOf(path, cwd)}</span>
      </button>
    </TitleTooltip>
  )
}

function InstructionsSection(props: AgentSectionProps) {
  const { onOpenFile, state, viewerContextId } = props
  const instructions = instructionsOf(state)
  const source = usePromptSource(props)
  const { agentId } = source
  const { query, prompt, tokens } = useSystemPrompt(source, viewerContextId)
  const [openFile, setOpenFile] = React.useState<string | null>(null)
  /** The key of the open part, or null for the full system prompt. */
  const [openPart, setOpenPart] = React.useState<string | null | undefined>()
  const cwd = prompt?.cwd ?? instructions?.cwd ?? ""
  const open = (path: string) => {
    // A file outside the agent folder opens from its absolute path.
    const relative = relativePath(path, cwd)
    setOpenPart(undefined)
    if (onOpenFile) onOpenFile(relative ?? path)
    else setOpenFile(path)
  }
  const parts = prompt ? partsOf(prompt.sections) : []
  const countOf = (part: Part) =>
    tokens?.parts[part.key] ?? tokens?.parts[part.section.id]
  const part = parts.find((item) => item.key === openPart)
  const tools = tokens?.tools
  const overhead =
    tools?.overhead && tools.overhead.tokens > 0 ? tools.overhead : undefined
  const segments: Segment[] = [
    ...parts.map((item, index) => ({
      key: item.key,
      label: item.title,
      tokens: countOf(item)?.tokens ?? 0,
      exact: countOf(item)?.exact ?? false,
      color: partColor(index),
    })),
    ...(tools && tools.items.length > 0
      ? [
          {
            key: "tools",
            label: `Tools (${tools.items.length})`,
            tokens: tools.total.tokens - (overhead?.tokens ?? 0),
            exact: tools.total.exact,
            color: TOOLS_COLOR,
          },
          {
            key: "tools:overhead",
            label: "Tool use overhead",
            tokens: overhead?.tokens ?? 0,
            exact: overhead?.exact ?? false,
            color: cn(TOOLS_COLOR, "opacity-50"),
          },
        ]
      : []),
  ]
  const partCount = part ? countOf(part) : undefined
  return (
    <>
      {source.preview ? (
        <TitleTooltip title={source.preview}>
          <p className="truncate px-1.5 pb-2 text-xs text-muted-foreground">
            Preview for a new agent in {folderName(source.preview)}
          </p>
        </TitleTooltip>
      ) : null}
      {prompt ? (
        <div className="space-y-3 pt-1">
          {tokens ? <ShareBar segments={segments} /> : null}
          <section aria-label="System prompt">
            <GroupHeader title="System prompt" count={tokens?.prompt} />
            <ul>
              {parts.map((item, index) => (
                <Row
                  key={item.key}
                  color={partColor(index)}
                  name={item.title}
                  suffix={
                    item.files.length > 0
                      ? item.files.map((path) => labelOf(path, cwd)).join(", ")
                      : undefined
                  }
                  count={countOf(item)}
                  label={`Show ${item.title}`}
                  onClick={() => setOpenPart(item.key)}
                />
              ))}
              <Row
                name="Full system prompt"
                label="Show the full system prompt"
                onClick={() => setOpenPart(null)}
              />
            </ul>
            {estimateNote(tokens) ? (
              <GroupFooter>{estimateNote(tokens)}</GroupFooter>
            ) : null}
          </section>
          {tokens ? <ToolsGroup tokens={tokens} /> : null}
        </div>
      ) : instructions ? (
        // Until the prompt loads, or if it cannot load: the files.
        <ul className="space-y-0.5">
          {instructions.files.map(({ path }) => (
            <li key={path}>
              <FileRow path={path} cwd={cwd} onOpen={open} />
            </li>
          ))}
        </ul>
      ) : null}
      {query.isError && !prompt ? (
        <p className="px-1.5 text-xs text-destructive">
          Could not load the system prompt.
        </p>
      ) : null}
      {openFile ? (
        <TextDialog
          open
          onOpenChange={(next) => {
            if (!next) setOpenFile(null)
          }}
          title={labelOf(openFile, cwd)}
          path="/api/agent/instructions"
          searchParams={{
            path: openFile,
            ...(source.preview ? { cwd: source.preview } : {}),
          }}
          agentId={agentId}
          viewerContextId={viewerContextId}
          scrollToEnd={false}
          markdown
        />
      ) : null}
      {prompt && openPart === null ? (
        <TextDialog
          open
          onOpenChange={(next) => {
            if (!next) setOpenPart(undefined)
          }}
          title="Full system prompt"
          path={source.path}
          searchParams={source.searchParams}
          agentId={agentId}
          viewerContextId={viewerContextId}
          scrollToEnd={false}
          copy
          details={
            <DialogDescription>
              {source.preview
                ? "A preview: a new agent in this folder gets this with its first message, before the conversation. When a part changes later, the agent gets only that part again, as an update."
                : prompt.sent
                  ? "The conversation messages come after the system prompt. When a part changes, the agent gets only that part again, as an update."
                  : "Not sent yet: the agent gets this with its first message, before the conversation. When a part changes later, the agent gets only that part again, as an update."}
              {prompt.sent && prompt.updates > 0
                ? ` ${prompt.updates} ${prompt.updates === 1 ? "update" : "updates"} so far.`
                : ""}
            </DialogDescription>
          }
        />
      ) : null}
      {part ? (
        <TextDialog
          open
          onOpenChange={(next) => {
            if (!next) setOpenPart(undefined)
          }}
          title={part.title}
          path={source.path}
          searchParams={{
            ...source.searchParams,
            section: part.section.id,
            ...(part.key === "project_context:global"
              ? { scope: "global" }
              : part.key === "project_context:project"
                ? { scope: "project" }
                : {}),
          }}
          agentId={agentId}
          viewerContextId={viewerContextId}
          scrollToEnd={false}
          copy
          details={
            <>
              <DialogDescription>{part.description}</DialogDescription>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {partCount ? (
                  <span className="tabular-nums">
                    {formatTokens(partCount)} tokens
                  </span>
                ) : null}
                {part.section.tagged ? (
                  <code className="font-mono">{`<${part.section.id}>`}</code>
                ) : null}
                <FileLinks files={part.files} cwd={cwd} onOpen={open} />
              </div>
            </>
          }
        />
      ) : null}
    </>
  )
}

registerAgentSection({
  key: "instructions",
  title: "Instructions",
  order: 70,
  defaultOpen: false,
  // Every agent has a system prompt.
  visible: () => true,
  // A new agent also gets a system prompt: show it before the first prompt.
  preview: true,
  Summary: InstructionsSummary,
  Component: InstructionsSection,
})
