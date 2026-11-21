/**
 * The system prompt of an agent, part by part, as the model gets it.
 *
 * pi-durable renders the agent's prompt sections before each request and
 * stores the changes as system messages in the transcript: one complete
 * prompt first, then only the sections that changed. The model request
 * replays these messages. This module replays them the same way (pi-ai's
 * `getCurrentSystemMessage` and `getSystemMessageText`), so the result is
 * the prompt in effect now, and cannot drift from what the model got.
 *
 * An agent without a request yet has no system messages. Then the sections
 * are rendered as the next request renders them, as a preview.
 */
import type { Context } from "@earendil-works/chord/context"
import {
  getCurrentSystemMessage,
  getCurrentTools,
  getSystemMessageText,
  toToolDeclaration,
  type Message,
  type Tool,
} from "@earendil-works/pi-ai"
import type {
  Agent,
  DocumentReader,
  PromptInput,
} from "@earendil-works/pi-durable"

import type { PiResources } from "./resources.ts"

/** The `kind` of the `agent_extensions` event when the prompt changes. */
export const SYSTEM_PROMPT_KIND = "system_prompt"

/** The reserved section key of the agent's own `instructions`. */
const INSTRUCTIONS_KEY = "instructions"

export type SystemPromptFile = { path: string; scope: "global" | "project" }

export type SystemPromptSection = {
  /** The section key, as in `<key>`. */
  id: string
  /** The extension whose code renders the section, if known. */
  extension?: string
  title: string
  /** The file that the text comes from, if one file. */
  source?: string
  /** The context files in the section (`project_context`). */
  files?: SystemPromptFile[]
  /** The text exactly as the model gets it, with the tags if `tagged`. */
  text: string
  /** The text is wrapped in `<id>` and `</id>`. */
  tagged: boolean
}

export type SystemPrompt = {
  cwd: string
  /**
   * True: replayed from the system messages of the conversation, as the
   * model got it. False: no request yet; rendered as the next request will.
   */
  sent: boolean
  /** System messages after the first that changed sections. */
  updates: number
  sections: SystemPromptSection[]
  /** The full system prompt text, exactly as the model request renders it. */
  text: string
  /** The tool definitions that the model request offers with the prompt. */
  tools: Tool[]
}

const TITLES: Record<string, string> = {
  preamble: "Preamble",
  rules: "Rules",
  addendum: "Addendum",
  project_context: "Project context",
  skills: "Skills",
  cwd: "Working directory",
  [INSTRUCTIONS_KEY]: "Agent instructions",
  codemode: "Code mode",
  todo: "Todo list",
  project_jobs: "Project jobs",
}

function titleOf(key: string) {
  return (
    TITLES[key] ??
    key
      .split(/[_-]+/)
      .filter(Boolean)
      .map((word, index) =>
        index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word
      )
      .join(" ")
  )
}

/**
 * The extension whose code renders a section of `agent`: the last selected
 * one that provides or wraps it, as pi-durable resolves it.
 */
export function sectionExtension(agent: Agent, key: string) {
  if (key === INSTRUCTIONS_KEY && agent.instructions !== undefined)
    return undefined
  let found: string | undefined
  for (const extension of agent.extensions) {
    if (
      extension.sections?.some((section) => section.key === key) ||
      extension.wraps?.some((wrap) => "section" in wrap && wrap.section === key)
    )
      found = extension.name
  }
  return found
}

/** Text of a section, tagged when `tag` is not false, as pi-durable does. */
function tagged(key: string, text: string, tag: boolean | undefined) {
  return tag === false ? text : `<${key}>\n${text}\n</${key}>`
}

/**
 * Render the agent's sections in order, as pi-durable's request
 * preparation does: `undefined` leaves a section out, and a section that
 * throws is left out (the request keeps its shown text; there is none yet).
 */
export async function renderSections(
  agent: Agent,
  input: Omit<PromptInput, "agent" | "shown">,
  context: Context
) {
  const rendered: Array<[string, string]> = []
  const full = { ...input, agent, shown: {} } as PromptInput
  for (const section of agent.sections) {
    let text: string | undefined
    try {
      text = await section.render(full, context)
    } catch (error) {
      console.warn(`[smith] prompt section ${section.key} failed:`, error)
      continue
    }
    if (text === undefined) continue
    rendered.push([section.key, tagged(section.key, text, section.tag)])
  }
  return rendered
}

/** The sections in effect after the system messages of a model context. */
export function replayedSections(messages: readonly Message[]) {
  const current = getCurrentSystemMessage(messages)
  if (!current) return undefined
  const updates = messages.filter(
    (message) => message.role === "system" && message.sections !== undefined
  ).length
  const sections: Array<[string, string]> = []
  const content = getSystemMessageText({ ...current, sections: undefined })
  if (content.length > 0) sections.push(["system", content])
  for (const [key, value] of Object.entries(current.sections ?? {}))
    if (value !== null) sections.push([key, value])
  return {
    sections,
    text: getSystemMessageText(current),
    updates: Math.max(0, updates - 1),
  }
}

/** Describe the sections: titles, extensions, and their source files. */
export function describeSections(
  sections: ReadonlyArray<readonly [string, string]>,
  options: {
    agent: Agent | undefined
    resources: PiResources | undefined
    agentDir: string
  }
): SystemPromptSection[] {
  const { agent, resources, agentDir } = options
  const root = agentDir.replace(/\/+$/, "")
  return sections.map(([id, text]) => {
    const wrapped = text.startsWith(`<${id}>\n`) && text.endsWith(`\n</${id}>`)
    const section: SystemPromptSection = {
      id,
      title: titleOf(id),
      text,
      tagged: wrapped,
    }
    const extension = agent ? sectionExtension(agent, id) : undefined
    if (extension) section.extension = extension
    if (id === "preamble" && resources?.systemPromptPath)
      section.source = resources.systemPromptPath
    if (id === "addendum" && resources?.appendSystemPromptPaths.length === 1)
      section.source = resources.appendSystemPromptPaths[0]
    if (id === "project_context" && resources) {
      section.files = resources.agentsFiles
        .filter(({ path }) => text.includes(`path="${path}"`))
        .map(({ path }) => ({
          path,
          scope: path.startsWith(`${root}/`) ? "global" : "project",
        }))
    }
    return section
  })
}

/** The system prompt of a conversation: replayed if sent, else rendered. */
export async function systemPromptOf(options: {
  cwd: string
  messages: readonly Message[]
  agent: Agent
  /** Builds the environment, as `HarnessOptions.env` does. */
  env: () => PromptInput["env"]
  read: DocumentReader
  conversationId: PromptInput["conversationId"]
  resources: PiResources | undefined
  agentDir: string
  context: Context
}): Promise<SystemPrompt> {
  const { agent, resources, agentDir, cwd } = options
  const replayed = replayedSections(options.messages)
  if (replayed) {
    return {
      cwd,
      sent: true,
      updates: replayed.updates,
      sections: describeSections(replayed.sections, {
        agent,
        resources,
        agentDir,
      }),
      text: replayed.text,
      tools: getCurrentTools(options.messages),
    }
  }
  const rendered = await renderSections(
    agent,
    {
      conversationId: options.conversationId,
      env: options.env(),
      read: options.read,
    },
    options.context
  )
  return {
    cwd,
    sent: false,
    updates: 0,
    sections: describeSections(rendered, { agent, resources, agentDir }),
    // As pi-ai renders a system message: the sections, joined.
    text: getSystemMessageText({
      role: "system",
      content: "",
      sections: Object.fromEntries(rendered),
      timestamp: 0,
    }),
    tools: agent.tools.map(toToolDeclaration),
  }
}
