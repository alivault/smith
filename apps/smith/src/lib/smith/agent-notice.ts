/**
 * Notices that the server puts into a conversation as user messages: the
 * reports and messages of other agents, and the notices of background jobs.
 * The model reads them as text; the web client shows them as compact cards.
 *
 * The formats come from the server: `reportMessage` and the `agents send`
 * action (`server/src/extensions/agents.ts`), `stallMessage`
 * (`server/src/core/bash-calls.ts`), and the job notices
 * (`server/src/extensions/jobs.ts`), the messages of watches and timers
 * (`watchMessage`, `timerMessage`), and the reminder to ask with ask_user
 * that older versions sent. The parser is strict: only these exact
 * headers match, so a normal prompt that starts with `[` stays a prompt.
 * `server/test/agent-notice.test.ts` checks it against the server text.
 *
 * Keep this file free of imports: the server tests load it directly.
 */

/** The color of the state: amber for a question, red for a failure. */
export type AgentNoticeTone = "default" | "attention" | "muted" | "error"

export type AgentNotice = {
  kind: "agent" | "job" | "watch" | "timer" | "reminder"
  /**
   * The first word of the summary: "Subagent", "Agent", "Job", "Watch",
   * "Timer", or "Smith".
   */
  label: string
  /** The agent that sent it, for example `s12` or `workbox:s12`. */
  agentId?: string
  jobId?: string
  /** For example "done", "question", "finished", "failed". */
  state: string
  tone: AgentNoticeTone
  /** The rest of the summary line: a title, or a job name and its exit. */
  summary: string
  /** The body. Markdown when `markdown` is true, otherwise plain text. */
  body: string
  markdown: boolean
  /** The instruction line for the model, shown muted. */
  hint?: string
  /** The command of a job, or what a watch checks. */
  command?: string
  /** The last output of a job, for a monospace block. */
  output?: string
}

/** A local agent ID that the client can open, as `agentIdOf` makes it. */
export function isLocalAgentId(id: string) {
  return /^s\d+$/.test(id)
}

export function parseAgentNotice(text: string): AgentNotice | null {
  if (!text.startsWith("[") && !text.startsWith("Agent ")) return null
  return (
    parseAgentReport(text) ??
    parseAgentMessage(text) ??
    parseStall(text) ??
    parseJobNotice(text) ??
    parseWatch(text) ??
    parseTimer(text) ??
    parseReminder(text)
  )
}

function splitFirstLine(text: string) {
  const index = text.indexOf("\n")
  return index === -1
    ? { first: text, rest: "" }
    : { first: text.slice(0, index), rest: text.slice(index + 1) }
}

const REPORT_HEAD =
  /^\[(Subagent|Agent) (\S(?:.*\S)?): (done|done, stopped|question)\](?: (.*))?$/

/** `[Subagent s12: done] Title`, then the answer, then maybe a hint. */
function parseAgentReport(text: string): AgentNotice | null {
  const { first, rest } = splitFirstLine(text)
  const head = REPORT_HEAD.exec(first)
  if (!head) return null
  const [, label, agentId, state, title = ""] = head
  let body = rest
  let hint: string | undefined
  if (state === "question") {
    const hints = [
      `It waits for the user in its ask_user question. You can also answer with agents send (id ${agentId}).`,
      `Answer it with agents send (id ${agentId}). To give it a tool, use agents send with add.`,
    ]
    const lines = body.split("\n")
    const last = lines.at(-1) ?? ""
    if (hints.includes(last)) {
      hint = last
      body = lines.slice(0, -1).join("\n")
    }
  }
  return {
    kind: "agent",
    label,
    agentId,
    state: state === "done, stopped" ? "stopped" : state,
    tone:
      state === "question"
        ? "attention"
        : state === "done, stopped"
          ? "muted"
          : "default",
    summary: title.trim(),
    body,
    markdown: true,
    ...(hint ? { hint } : {}),
  }
}

const MESSAGE_HEAD = /^\[Message from agent (\S+)( on the hub)?\] /

/** `[Message from agent s12] text`, from `agents send`. */
function parseAgentMessage(text: string): AgentNotice | null {
  const head = MESSAGE_HEAD.exec(text)
  if (!head) return null
  const body = text.slice(head[0].length)
  return {
    kind: "agent",
    label: "Agent",
    agentId: head[1],
    state: head[2] ? "message, on the hub" : "message",
    tone: "default",
    summary: splitFirstLine(body).first.trim(),
    body,
    markdown: true,
  }
}

const STALL_HEAD =
  /^Agent (s\d+)(?: \((.*)\))? may hang: one bash call has run for (.+?), with no new output for (.+?)(?: and almost no CPU or I\/O)?\.$/

/** A subagent's bash call seems to hang (`stallMessage`). */
function parseStall(text: string): AgentNotice | null {
  const lines = text.split("\n")
  const head = STALL_HEAD.exec(lines[0] ?? "")
  if (
    !head ||
    lines.length !== 4 ||
    !lines[1].startsWith("Command: ") ||
    !lines[2].startsWith("PIDs: ")
  )
    return null
  return {
    kind: "agent",
    label: "Subagent",
    agentId: head[1],
    state: "may hang",
    tone: "attention",
    summary: [head[2], `bash call ran ${head[3]}, silent ${head[4]}`]
      .filter(Boolean)
      .join(" · "),
    body: lines.slice(0, 3).join("\n"),
    markdown: false,
    hint: lines[3],
  }
}

const JOB_EXIT_HEAD =
  /^\[Job (finished|failed)\] (.+) exited with code (\S+) after (.+?)(, while the Smith server restarted)?\.$/
const JOB_LINE = /^\(job (\S+): ([\s\S]*)\)$/
const JOB_LOST_HEAD =
  /^\[Job lost\] (.+) stopped because (.+)\. Read its output with terminal output \(id (\S+)\)\.$/
const JOB_WAITS_HEAD =
  /^\[Job waits for input\] (.+) \(job (\S+)\) waits for input/
const JOB_IGNORED_HEAD =
  /^\[Job input not taken\] The user pressed Enter in (.+) \(job (\S+)\), but /
const JOB_CHANGED_HEAD = /^\[Job changed\] (.+) \(job (\S+)\)\.$/

function job(
  state: string,
  tone: AgentNoticeTone,
  fields: Omit<AgentNotice, "kind" | "label" | "state" | "tone" | "markdown">
): AgentNotice {
  return { kind: "job", label: "Job", state, tone, markdown: false, ...fields }
}

function parseJobNotice(text: string): AgentNotice | null {
  if (!text.startsWith("[Job ")) return null
  const { first, rest } = splitFirstLine(text)

  const exit = JOB_EXIT_HEAD.exec(first)
  if (exit) {
    // The command can have new lines: the output starts after the last
    // "Last output:" line that follows the job line.
    const marker = rest.indexOf(")\nLast output:\n")
    if (marker === -1) return null
    const line = JOB_LINE.exec(rest.slice(0, marker + 1))
    if (!line) return null
    const [, state, name, code, duration, restarted] = exit
    return job(state, state === "failed" ? "error" : "default", {
      jobId: line[1],
      command: line[2],
      summary: [
        name,
        `exit ${code}`,
        duration + (restarted ? ", during a server restart" : ""),
      ].join(" · "),
      // The summary has all of the first line.
      body: "",
      output: rest.slice(marker + ")\nLast output:\n".length),
    })
  }

  const lost = JOB_LOST_HEAD.exec(first)
  if (lost) {
    const line = JOB_LINE.exec(rest)
    if (!line || line[1] !== lost[3]) return null
    return job("lost", "error", {
      jobId: lost[3],
      command: line[2],
      summary: `${lost[1]} · ${lost[2]}`,
      body: first,
    })
  }

  const waits = JOB_WAITS_HEAD.exec(first)
  if (waits) {
    const lines = rest.split("\n")
    if (lines.length !== 2 || !lines[0].startsWith("Last line: ")) return null
    return job("waits for input", "attention", {
      jobId: waits[2],
      summary: waits[1],
      body: [first, lines[0]].join("\n"),
      hint: lines[1],
    })
  }

  const ignored = JOB_IGNORED_HEAD.exec(first)
  if (ignored) {
    if (!rest.startsWith("Last line: ") || rest.includes("\n")) return null
    return job("input not taken", "attention", {
      jobId: ignored[2],
      summary: ignored[1],
      body: text,
    })
  }

  const changed = JOB_CHANGED_HEAD.exec(first)
  if (changed && !rest) {
    return job("changed", "muted", {
      jobId: changed[2],
      summary: changed[1],
      body: text,
    })
  }

  return null
}

const WATCH_LINE = /^\(watch (\S+): ([\s\S]*), (\d+) check\(s\)\)$/
const WATCH_TIMEOUT_HEAD =
  /^\[Watch timed out\] (.*): the condition did not come true\.$/

/** `[Watch] message` or `[Watch timed out] label: …`, from `watchMessage`. */
function parseWatch(text: string): AgentNotice | null {
  if (!text.startsWith("[Watch")) return null
  const marker = text.indexOf(")\nLast check:\n")
  if (marker === -1) return null
  const head = text.slice(0, marker + 1)
  const lineStart = head.lastIndexOf("\n(watch ")
  if (lineStart === -1) return null
  const first = head.slice(0, lineStart)
  const line = WATCH_LINE.exec(head.slice(lineStart + 1))
  if (!line) return null
  const output = text.slice(marker + ")\nLast check:\n".length)
  const timeout = WATCH_TIMEOUT_HEAD.exec(first)
  if (!timeout && !first.startsWith("[Watch] ")) return null
  return {
    kind: "watch",
    label: "Watch",
    state: timeout ? "timed out" : "fired",
    tone: timeout ? "attention" : "default",
    summary: timeout
      ? timeout[1]
      : splitFirstLine(first.slice("[Watch] ".length)).first.trim(),
    body: timeout ? "" : first.slice("[Watch] ".length),
    markdown: true,
    command: `${line[2]} (${line[3]} checks)`,
    output,
  }
}

const TIMER_HEAD = /^\[Timer(?:, run (\d+))?\] /
const TIMER_LINE = /\n\(timer (\S+)(?:: [^\n]*)?\)$/

/** `[Timer] message` or `[Timer, run 3] message`, from `timerMessage`. */
function parseTimer(text: string): AgentNotice | null {
  const head = TIMER_HEAD.exec(text)
  const line = TIMER_LINE.exec(text)
  if (!head || !line) return null
  const body = text.slice(head[0].length, line.index)
  return {
    kind: "timer",
    label: "Timer",
    state: head[1] ? `run ${head[1]}` : "fired",
    tone: "default",
    summary: splitFirstLine(body).first.trim(),
    body,
    markdown: true,
    hint: line[0].slice(1),
  }
}

const REMINDER_HEAD =
  "[Plain-text question] Your last message ends with a question to the user in plain text."

/**
 * Smith asked the agent to ask with ask_user. Smith no longer sends it, but
 * older conversations have it.
 */
function parseReminder(text: string): AgentNotice | null {
  if (!text.startsWith(REMINDER_HEAD)) return null
  return {
    kind: "reminder",
    label: "Smith",
    state: "reminder",
    tone: "muted",
    summary: "Ask the question with ask_user",
    body: text.slice("[Plain-text question] ".length),
    markdown: false,
  }
}
