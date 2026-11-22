/**
 * Deferred tools: tools that every request does not send in full.
 *
 * Tool definitions go with every request, so a rarely used tool costs its
 * tokens each turn. Smith marks such tools `deferred` (pi-durable): the
 * model is not offered them until they are loaded. The `deferred_tools`
 * prompt section lists them with one line each, and `load_tools` loads
 * them by name. Loading writes the conversation's `modelTools` (pi-durable's
 * `control.addTools`), so a loaded tool stays offered for the rest of the
 * conversation: after a restart, a replay, and a compaction too. Scripts
 * (`codemode`) can call deferred tools at any time.
 *
 * A model can also call a listed tool before it loads it: the call does not
 * run, the tool loads, and the model calls it again. Agents from before
 * deferred tools keep the deferred tools that they used: `usedDeferredTools`
 * finds them before Smith sends a prompt.
 *
 * Caching: loading a tool changes the tool list one time. pi-ai sends the
 * change in place for Anthropic models with mid-conversation tool changes
 * (`tool_addition`), so the cached prefix stays; for other models the next
 * request writes the cache again, one time. The section text does not
 * change when a tool loads, so it does not break the cache.
 */
import type { Context } from "@earendil-works/chord/context"
import type { Message } from "@earendil-works/pi-ai"
import {
  type Conversation,
  defineTool,
  hook,
  section,
  ToolTask,
  type Agent,
  type Extension,
  type HookApi,
  type PromptSection,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import Type from "typebox"

import { textResult } from "./util.ts"

/** Tools that are deferred by default: rarely used, and large. */
export const DEFERRED_TOOLS: readonly string[] = [
  "browser",
  "codemode",
  "fetch_content",
  "schedule",
  "watch",
  "web_search",
]

export const LOAD_TOOLS_NAME = "load_tools"

/** One line for each deferred tool, in the section. */
const SUMMARIES: Record<string, string> = {
  browser: "your own browser: open, read, click, fill, screenshot",
  codemode: "run JavaScript that calls tools: many calls, loops",
  fetch_content: "fetch URLs, GitHub repositories, PDFs; read stored results",
  schedule: "a timer that sends you a message later (in, at, every, cron)",
  watch: "wait in the background for a command, URL, file, or PR checks",
  web_search: "search the web",
}

/** `extension` with the tools of `names` deferred. */
export function deferTools(
  extension: Extension,
  names: readonly string[] = DEFERRED_TOOLS
): Extension {
  if (!extension.tools?.some((tool) => names.includes(tool.name)))
    return extension
  return {
    ...extension,
    tools: extension.tools.map((tool) =>
      names.includes(tool.name) ? { ...tool, deferred: true as const } : tool
    ),
  }
}

/** The first sentence of a description, for a tool without a summary. */
function firstSentence(text: string) {
  const line = text.trim().split("\n")[0] ?? ""
  const end = line.search(/[.:;](\s|$)/)
  return (end > 0 ? line.slice(0, end) : line).trim()
}

export function summaryOf(
  tool: Pick<ToolRegistration, "name" | "description">
) {
  return SUMMARIES[tool.name] ?? firstSentence(tool.description)
}

/**
 * The deferred tools of an agent, loaded or not, by name: the section
 * lists all of them, so its text does not change when one loads.
 */
export function deferredToolsOf(agent: Pick<Agent, "tools" | "deferred">) {
  const byName = new Map<string, Agent["tools"][number]>()
  for (const tool of [...agent.tools, ...agent.deferred])
    if (tool.deferred === true) byName.set(tool.name, tool)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The text of the `deferred_tools` section, or undefined without them. */
export function deferredSectionText(agent: Pick<Agent, "tools" | "deferred">) {
  const tools = deferredToolsOf(agent)
  if (tools.length === 0) return undefined
  return [
    `Load these tools with ${LOAD_TOOLS_NAME} before you use them the first time. A loaded tool stays loaded.`,
    ...tools.map((tool) => `- ${tool.name}: ${summaryOf(tool)}`),
  ].join("\n")
}

export const deferredSection: PromptSection = section(
  "deferred_tools",
  (input) => deferredSectionText(input.agent)
)

/** What loading `names` does for an agent: what loads, and what does not. */
export function planLoad(
  agent: Pick<Agent, "tools" | "deferred">,
  names: readonly string[]
) {
  const deferred = new Set(agent.deferred.map((tool) => tool.name))
  const offered = new Set(agent.tools.map((tool) => tool.name))
  const load: string[] = []
  const loaded: string[] = []
  const unknown: string[] = []
  for (const name of new Set(names.map((item) => item.trim()))) {
    if (!name) continue
    if (deferred.has(name)) load.push(name)
    else if (offered.has(name)) loaded.push(name)
    else unknown.push(name)
  }
  return { load, loaded, unknown }
}

export const loadToolsTool = defineTool({
  name: LOAD_TOOLS_NAME,
  description:
    "Load deferred tools by name (see deferred_tools). You can call them from your next call, and they stay loaded.",
  parameters: Type.Object({
    names: Type.Array(Type.String()),
  }),
  // Loading changes what the model is offered; scripts call any tool.
  callers: ["model"],
  replay: "safe",
  async execute(args, api, context) {
    const plan = planLoad(await api.agent(context), args.names)
    const lines = [
      plan.load.length > 0 ? `Loaded: ${plan.load.join(", ")}.` : "",
      plan.loaded.length > 0
        ? `Already loaded: ${plan.loaded.join(", ")}.`
        : "",
      plan.unknown.length > 0
        ? `Not available to you: ${plan.unknown.join(", ")}.`
        : "",
    ].filter(Boolean)
    return textResult(lines.join(" ") || "No tool names.", {
      ...(plan.load.length === 0 && plan.loaded.length === 0
        ? { isError: true }
        : {}),
      details: plan,
      ...(plan.load.length > 0 ? { control: { addTools: plan.load } } : {}),
    })
  },
})

/** The agent of a hook, when the hook API has it (the tool runtime does). */
async function hookAgent(api: HookApi, context: Context) {
  const withAgent = api as HookApi & {
    agent?: (context: Context) => Promise<Agent>
  }
  if (typeof withAgent.agent !== "function") return undefined
  return withAgent.agent(context)
}

/**
 * A model call to a deferred tool that is not loaded does not run: it loads
 * the tool, and the result tells the model to call it again.
 */
export const loadOnCallHook = hook(ToolTask, {
  afterTool: async (call, result, api, context) => {
    if (call.parent) return undefined
    const unavailable = result.diagnostics?.some(
      (diagnostic) => diagnostic.code === "tool_unavailable"
    )
    if (!unavailable) return undefined
    const agent = await hookAgent(api, context)
    if (!agent) return undefined
    const { load } = planLoad(agent, [call.name])
    if (load.length === 0) return undefined
    return {
      ...result,
      output: [
        {
          type: "text",
          text: `${call.name} was not loaded, so this call did not run. It is loaded now: call it again.`,
        },
      ],
      control: { addTools: load },
    }
  },
})

/** The parts of the `smith` extension for deferred tools. */
export const deferredParts = {
  tools: [loadToolsTool],
  sections: [deferredSection],
  hooks: [loadOnCallHook],
}

/**
 * The deferred tools that the model called in `messages` and is not offered
 * now: for agents from before deferred tools, which keep them.
 */
export function usedDeferredTools(
  messages: readonly Message[],
  agent: Pick<Agent, "deferred">
) {
  const deferred = new Set(agent.deferred.map((tool) => tool.name))
  if (deferred.size === 0) return []
  const used = new Set<string>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.content)
      if (part.type === "toolCall" && deferred.has(part.name))
        used.add(part.name)
  }
  return [...used]
}

/**
 * Load the deferred tools that the model of `conversation` called before
 * they were deferred, so an agent from before deferred tools keeps them.
 * Returns the loaded names.
 */
export async function loadUsedDeferredTools(
  conversation: Pick<Conversation, "agent" | "context" | "configure">,
  context: Context
) {
  const agent = await conversation.agent(context)
  if (agent.deferred.length === 0) return []
  const used = usedDeferredTools(
    (await conversation.context(context)).messages,
    agent
  )
  if (used.length === 0) return []
  const keep = new Set([
    ...agent.tools
      .filter((tool) => tool.deferred === true)
      .map((tool) => tool.name),
    ...used,
  ])
  await conversation.configure(
    {
      modelTools: {
        add: [...agent.tools, ...agent.deferred].filter((tool) =>
          keep.has(tool.name)
        ),
      },
    },
    context
  )
  return used
}
