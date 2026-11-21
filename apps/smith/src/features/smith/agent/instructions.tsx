import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  ChevronRightIcon,
  FileTextIcon,
  ScrollTextIcon,
  WrenchIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { TitleTooltip } from "@/components/ui/tooltip"
import {
  registerAgentSection,
  type AgentSectionProps,
} from "@/features/smith/agent/agent-panel"
import { TextDialog } from "@/features/smith/agent/shared"
import { buildRequestUrl, fetchJson } from "@/features/smith/app-shell-utils"
import { useMachineId } from "@/lib/smith/machine-context"
import { useSmithEvent } from "@/features/smith/agent/events"
import {
  cacheNote,
  contextShare,
  formatTokens,
  methodLabel,
  type PromptTokens,
  type TokenCount,
} from "@/features/smith/agent/prompt-tokens"

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

function instructionsOf(state: Record<string, unknown>) {
  const value = state.instructions as Instructions | undefined
  return value && Array.isArray(value.files) ? value : undefined
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

/** A token count at the right of a row. */
function Tokens({ count }: { count: TokenCount | undefined }) {
  if (!count) return null
  return (
    <span className="shrink-0 text-xs leading-5 text-muted-foreground tabular-nums">
      {formatTokens(count)}
    </span>
  )
}

/** The total, its share of the context window, and the cache note. */
function TokenSummary({ tokens }: { tokens: PromptTokens }) {
  const share = contextShare(tokens.total.tokens, tokens.model?.contextWindow)
  const note = cacheNote(tokens)
  return (
    <div className="space-y-0.5 px-1.5">
      <p className="text-xs text-foreground/90 tabular-nums">
        System prompt and tools · {formatTokens(tokens.total)} tokens
        {share ? ` · ${share} of context` : ""}
      </p>
      <p className="text-xs text-muted-foreground">
        {methodLabel(tokens)}
        {note ? ` ${note}` : ""}
      </p>
    </div>
  )
}

/** The tool definitions that each request sends; opens to list them. */
function ToolsRow({ index, tokens }: { index: number; tokens: PromptTokens }) {
  const [open, setOpen] = React.useState(false)
  const { items, overhead, total } = tokens.tools
  if (items.length === 0) return null
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Tools: ${items.length}`}
        className="flex w-full min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="w-4 shrink-0 text-right text-xs leading-5 text-muted-foreground tabular-nums">
          {index}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate text-sm">Tools ({items.length})</span>
            <ChevronRightIcon
              aria-hidden="true"
              className={`size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
            />
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            Name, description, and input schema of each tool
          </span>
        </span>
        <Tokens count={total} />
      </button>
      {open ? (
        <ul className="pb-1">
          {items.map((tool) => (
            <li
              key={tool.name}
              className="flex h-6 min-w-0 items-center gap-2 pr-1.5 pl-7 text-sm"
            >
              <WrenchIcon
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {tool.name}
              </span>
              <Tokens count={tool} />
            </li>
          ))}
          {overhead && overhead.tokens > 0 ? (
            <li className="flex h-6 min-w-0 items-center gap-2 pr-1.5 pl-7 text-sm">
              <span className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                Tool use overhead
              </span>
              <Tokens count={overhead} />
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  )
}

function FileRow({
  path,
  cwd,
  onOpen,
  indent = false,
}: {
  path: string
  cwd: string
  onOpen: (path: string) => void
  indent?: boolean
}) {
  return (
    <TitleTooltip title={path}>
      <button
        type="button"
        aria-label={`Show ${path}`}
        className={`flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 ${indent ? "pl-7" : ""}`}
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

function InstructionsSection({
  onOpenFile,
  agentId,
  state,
  viewerContextId,
}: AgentSectionProps) {
  const machineId = useMachineId()
  const instructions = instructionsOf(state)
  const query = useQuery({
    queryKey: ["smith", "system-prompt", viewerContextId, agentId],
    queryFn: () =>
      fetchJson<SystemPrompt>(
        buildRequestUrl(SYSTEM_PROMPT_PATH, {
          machineId,
          contextId: viewerContextId,
          agentId,
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
      query.dataUpdatedAt,
    ],
    enabled: pending,
    retry: false,
    queryFn: () =>
      fetchJson<{ tokens: PromptTokens }>(
        buildRequestUrl(TOKENS_PATH, {
          machineId,
          contextId: viewerContextId,
          agentId,
        })
      ),
  })
  // The server tells when the agent gets a new or changed system prompt.
  useSmithEvent("smith:agent-extensions", (detail) => {
    if (detail.agentId === agentId && detail.kind === "system_prompt")
      void query.refetch()
  })
  const [openFile, setOpenFile] = React.useState<string | null>(null)
  const [openSection, setOpenSection] = React.useState<{
    id?: string
    /** For the project context: only the global or the project files. */
    scope?: "global" | "project"
    title: string
  } | null>(null)
  const prompt = query.data
  const cwd = prompt?.cwd ?? instructions?.cwd ?? ""
  const open = (path: string) => {
    // A file outside the agent folder opens from its absolute path.
    const relative = relativePath(path, cwd)
    if (onOpenFile) onOpenFile(relative ?? path)
    else setOpenFile(path)
  }
  const parts = prompt ? partsOf(prompt.sections) : []
  const tokens =
    (pending ? exactQuery.data?.tokens : undefined) ?? prompt?.tokens
  return (
    <>
      {prompt ? (
        <div className="space-y-2">
          {tokens ? <TokenSummary tokens={tokens} /> : null}
          <div className="px-1.5 text-xs font-medium text-muted-foreground">
            What the agent gets, in order
          </div>
          <ol className="space-y-0.5">
            {parts.map((part, index) => (
              <li key={part.key}>
                <button
                  type="button"
                  aria-label={`Show ${part.title}`}
                  className="flex w-full min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                  onClick={() =>
                    setOpenSection({
                      id: part.section.id,
                      ...(part.key === "project_context:global"
                        ? { scope: "global" as const }
                        : part.key === "project_context:project"
                          ? { scope: "project" as const }
                          : {}),
                      title: part.title,
                    })
                  }
                >
                  <span className="w-4 shrink-0 text-right text-xs leading-5 text-muted-foreground tabular-nums">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="max-w-full shrink-0 truncate text-sm">
                        {part.title}
                      </span>
                      {part.section.tagged ? (
                        <span className="ml-auto min-w-0 truncate font-mono text-[10px] text-muted-foreground">
                          {`<${part.section.id}>`}
                        </span>
                      ) : null}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {part.description}
                    </span>
                  </span>
                  <Tokens
                    count={
                      tokens?.parts[part.key] ?? tokens?.parts[part.section.id]
                    }
                  />
                </button>
                {part.files.map((path) => (
                  <FileRow
                    key={path}
                    path={path}
                    cwd={cwd}
                    onOpen={open}
                    indent
                  />
                ))}
              </li>
            ))}
            {tokens ? (
              <ToolsRow index={parts.length + 1} tokens={tokens} />
            ) : null}
          </ol>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => setOpenSection({ title: "Full system prompt" })}
          >
            <ScrollTextIcon data-icon="inline-start" />
            View full system prompt
          </Button>
          <p className="px-1.5 text-xs text-muted-foreground">
            {prompt.sent
              ? "The conversation messages come after the system prompt. When a part changes, the agent gets only that part again, as an update."
              : "Not sent yet: the agent gets this with its first message, before the conversation. When a part changes later, the agent gets only that part again, as an update."}
            {prompt.sent && prompt.updates > 0
              ? ` ${prompt.updates} ${prompt.updates === 1 ? "update" : "updates"} so far.`
              : ""}
          </p>
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
          searchParams={{ path: openFile }}
          agentId={agentId}
          viewerContextId={viewerContextId}
          scrollToEnd={false}
          markdown
        />
      ) : null}
      {openSection ? (
        <TextDialog
          open
          onOpenChange={(next) => {
            if (!next) setOpenSection(null)
          }}
          title={openSection.title}
          path={SYSTEM_PROMPT_PATH}
          searchParams={
            openSection.id
              ? {
                  section: openSection.id,
                  ...(openSection.scope ? { scope: openSection.scope } : {}),
                }
              : {}
          }
          agentId={agentId}
          viewerContextId={viewerContextId}
          scrollToEnd={false}
          copy
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
  summary(state) {
    const count = instructionsOf(state)?.files.length ?? 0
    return count > 0
      ? `${count} ${count === 1 ? "file" : "files"}`
      : "System prompt"
  },
  Component: InstructionsSection,
})
