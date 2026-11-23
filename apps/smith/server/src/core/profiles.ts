/**
 * Tool profiles: named selections of extensions and tools for an agent.
 *
 * A profile is a capability choice, not an approval system: tools that a
 * profile keeps still run without asking. Built-in profiles are below; the
 * `profiles` setting adds more or replaces one by name.
 *
 * Subagents (agents with a parent) get more limits: no `ask_user` or
 * `spawn_subagent` unless the parent grants them, and a bash guard (see
 * `bashGuard`). The parent can add and remove tools for each subagent.
 *
 * A name with a dot, such as `browser.eval`, is an action of a tool. The
 * tool checks it with `actionRemoved`, so a profile can keep a tool and take
 * away only the actions that change things.
 *
 * A profile with `bash: "sandbox"` runs each bash call in a sandbox with a
 * read-only filesystem and no network (see `sandbox.ts`); `bash:
 * "sandbox-net"` is the same sandbox with the network. The `read-only` and
 * `reviewer` profiles keep bash only in the first, `researcher` only in the
 * second, so a model cannot change files with a script instead of the edit
 * tool. A parent that adds `bash` to a subagent gives it bash without the
 * sandbox.
 *
 * `spawnRefusal` checks a subagent's goal against its tools before it starts,
 * so a parent does not give a goal that changes files to a profile that
 * cannot change them.
 */
import type { Context } from "@earendil-works/chord/context"
import type {
  Conversation,
  Extension,
  RegistryReader,
  ToolRegistration,
} from "@earendil-works/pi-durable"

import type { SandboxMode } from "./sandbox.ts"

export type Profile = {
  name: string
  description: string
  /** Exactly these extensions, in this order; absent keeps every extension. */
  extensions?: string[]
  /** Tools to turn off. */
  removeTools?: string[]
  /** Text added to the system prompt. */
  instructions?: string
  /**
   * `sandbox`: bash runs with a read-only filesystem and no network.
   * `sandbox-net`: the same, with the network.
   */
  bash?: SandboxMode
  /** Deferred tools to load at once, for example `web_search`. */
  loadTools?: string[]
}

/** The tool limits of one agent, kept in its metadata. */
export type ToolLimits = {
  /** Tools to turn on, also when the profile or the subagent rules remove them. */
  add?: string[]
  /** Tools to turn off. */
  remove?: string[]
  /** Commands that bash refuses, in addition to the subagent rules. */
  denyCommands?: string[]
}

/** Tools that a subagent does not get unless its parent grants them. */
export const SUBAGENT_DENIED_TOOLS = ["ask_user", "spawn_subagent"]

const WRITE_TOOLS = [
  "write",
  "edit",
  "bash",
  "job_start",
  "terminal",
  // A command watch runs a shell command outside the bash sandbox.
  "watch.command",
  "browser.act",
  "browser.eval",
  "spawn_subagent",
  "agents.send",
  "agents.stop",
]

/** What a profile's bash sandbox lets a command do, for its instructions. */
export function sandboxInstructions(
  mode: SandboxMode,
  platform: NodeJS.Platform = process.platform
) {
  const network =
    mode === "sandbox-net"
      ? platform === "darwin"
        ? "Bash runs in a sandbox with the network, but not localhost."
        : "Bash runs in a sandbox with the network."
      : "Bash runs in a sandbox with no network."
  const files =
    platform === "darwin"
      ? "The filesystem is read-only: a write in the repository, the home directory, or a cache fails. Only the temp directories ($TMPDIR and /tmp) are writable."
      : "The filesystem is read-only; writes in the repository and in caches (for example a test build) work, but they are gone when the command ends."
  const git =
    mode === "sandbox-net"
      ? " Commands that read work (git log, git show, gh pr view, gh pr diff, curl); git fetch and git pull change .git, so they do not."
      : ""
  return `${network} ${files}${git}`
}

export const BUILTIN_PROFILES: readonly Profile[] = [
  {
    name: "full",
    description: "Every tool. The default.",
  },
  {
    name: "builder",
    description:
      "Build and change code: files, shell, git, and tests. No browser and no other agents.",
    removeTools: ["browser", "agents.send", "agents.stop", "agents.archive"],
    instructions:
      "You are a builder: make the change, run the checks and tests, and report what you changed and what you did not do.",
  },
  {
    name: "researcher",
    description:
      "Web research, reading files, and the browser. No file changes; bash runs in a sandbox with network.",
    extensions: [
      "coding-tools",
      "smith",
      "web-access",
      "mcp",
      "codemode",
      "ask",
      "scratchpad",
      "browser",
      "open-file",
      "todo",
      "schedule",
      "watch",
    ],
    removeTools: ["write", "edit", "browser.eval", "watch.command"],
    bash: "sandbox-net",
    loadTools: ["web_search", "fetch_content"],
    instructions: `You are a researcher: find and read sources, then report with links. Do not change files. ${sandboxInstructions("sandbox-net")}`,
  },
  {
    name: "reviewer",
    description:
      "Review changes: diffs, other agents, and tests. No file changes; bash runs in a sandbox without network.",
    removeTools: WRITE_TOOLS.filter(
      (tool) => tool !== "bash" && tool !== "agents.send"
    ),
    bash: "sandbox",
    instructions: `You are a reviewer: read the diff (git diff, agents read), run the tests, and report problems with file and line. Do not change files. ${sandboxInstructions("sandbox")}`,
  },
  {
    name: "read-only",
    description:
      "Read and analyze code, with git history, tests, and the web tools. No file changes; bash runs in a sandbox without network.",
    removeTools: WRITE_TOOLS.filter((tool) => tool !== "bash"),
    bash: "sandbox",
    instructions: `You are in read-only mode: do not change files or the repository. ${sandboxInstructions("sandbox")}`,
  },
]

/** Old names of built-in profiles. */
const ALIASES: Record<string, string> = {
  research: "researcher",
  review: "reviewer",
}

/** Built-in profiles, with the user's profiles added or replacing them by name. */
export function allProfiles(
  custom: Record<string, Omit<Profile, "name">> = {}
) {
  const byName = new Map(
    BUILTIN_PROFILES.map((profile) => [profile.name, profile])
  )
  for (const [name, profile] of Object.entries(custom)) {
    if (!/^[a-z0-9][a-z0-9-_]{0,31}$/i.test(name)) continue
    byName.set(name, {
      ...profile,
      name,
      description: profile.description ?? name,
    })
  }
  return [...byName.values()]
}

export function findProfile(
  name: string | undefined,
  custom: Record<string, Omit<Profile, "name">> = {}
) {
  if (!name) return undefined
  const profiles = allProfiles(custom)
  return (
    profiles.find((profile) => profile.name === name) ??
    profiles.find((profile) => profile.name === ALIASES[name])
  )
}

/** Clean a list of names from tool arguments or settings. */
export function nameList(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const names = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
  return names.length > 0 ? [...new Set(names)] : undefined
}

type SelectionOptions = { subagent?: { parent: string }; limits?: ToolLimits }

/**
 * Tool and action names from before the agent rename. Limits stored in an
 * agent's `smith.session` document and custom profiles in `settings.json` can
 * still have them, so they are read as the new names.
 */
const RENAMED_TOOLS: Record<string, string> = {
  spawn_session: "spawn_subagent",
  send_to_session: "agents.send",
  sessions: "agents",
  "sessions.stop": "agents.stop",
  "sessions.archive": "agents.archive",
}

function currentNames(names: readonly string[] | undefined) {
  return (names ?? []).map((name) => RENAMED_TOOLS[name] ?? name)
}

/** The tool and action names that a profile and the limits take away. */
export function removedNames(
  profile: Profile | undefined,
  options: SelectionOptions = {}
) {
  const add = new Set(currentNames(options.limits?.add))
  const removeNames = new Set([
    ...currentNames(profile?.removeTools),
    ...currentNames(options.limits?.remove),
    ...(options.subagent ? SUBAGENT_DENIED_TOOLS : []),
  ])
  for (const name of add) removeNames.delete(name)
  return removeNames
}

/**
 * True when an agent may not use `action` (`tool.action`, for example
 * `agents.stop`). Profiles and limits remove actions by this name.
 */
export function actionRemoved(
  action: string,
  profile: Profile | undefined,
  options: SelectionOptions = {}
) {
  return removedNames(profile, options).has(action)
}

/** What an agent gets: the extensions, the removed tools, and the prompt text. */
export function resolveSelection(
  registry: RegistryReader,
  profile: Profile | undefined,
  options: SelectionOptions = {}
) {
  const snapshot = registry.snapshot()
  const add = new Set(currentNames(options.limits?.add))
  const removeNames = removedNames(profile, options)
  let extensions: Extension[] | null = null
  if (profile?.extensions) {
    const names = currentNames(profile.extensions)
    // A tool that the parent adds brings its extension.
    for (const { tool, extension } of snapshot.tools())
      if (add.has(tool.name) && !names.includes(extension.name))
        names.push(extension.name)
    extensions = names.flatMap((name) => {
      const extension = snapshot.extension(name)
      return extension ? [extension] : []
    })
  }
  const kept = new Set(
    extensions ? extensions.map((extension) => extension.name) : undefined
  )
  const removeTools: ToolRegistration[] = []
  const removed: string[] = []
  const seen = new Set<string>()
  for (const { tool, extension } of snapshot.tools()) {
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    if (extensions && !kept.has(extension.name)) {
      removed.push(tool.name)
      continue
    }
    if (!removeNames.has(tool.name)) continue
    removeTools.push(tool)
    removed.push(tool.name)
  }
  // Actions of tools that the agent keeps, for example `browser.eval`.
  for (const name of removeNames) {
    const tool = name.split(".")[0]!
    if (name.includes(".") && seen.has(tool) && !removed.includes(tool))
      removed.push(name)
  }
  const parts: string[] = []
  if (profile?.instructions) parts.push(profile.instructions)
  if (options.subagent)
    parts.push(
      subagentInstructions(
        options.subagent.parent,
        profile,
        removed,
        options.limits
      )
    )
  return {
    extensions,
    removeTools,
    instructions: parts.length > 0 ? parts.join("\n\n") : null,
  }
}

function subagentInstructions(
  parent: string,
  profile: Profile | undefined,
  removed: string[],
  limits: ToolLimits | undefined
) {
  const deny = [
    "git push to main or master",
    "sudo",
    ...(limits?.denyCommands ?? []).map((command) => `\`${command}\``),
  ]
  return [
    `You are a subagent of agent ${parent}. Your parent gave you this work and limited your tools${profile && profile.name !== "full" ? ` (profile: ${profile.name})` : ""}.`,
    removed.length > 0
      ? `You do not have these tools or actions: ${removed.sort().join(", ")}.`
      : "",
    `Bash refuses: ${deny.join(", ")}.`,
    "If you need a tool, a command, or a decision, do not wait and do not work around the limit. End your turn with a message that starts with `Question:`. Give the question, the options, and your recommendation. Your parent reads it and answers you, and it can give you more tools.",
    "When the work is done, end your turn with a short report of what you did. Your parent gets the end of your turn as a message, so do not also send the report with agents send.",
    "If you end your turn to wait on a timer, a watch, or a job, your parent gets no message: it gets one when you end with a question or with done.",
  ]
    .filter(Boolean)
    .join(" ")
}

// -----------------------------------------------------------------------------
// What a subagent can do, and the check before it starts

/**
 * One line for each built-in profile, for the descriptions of the tools that
 * start agents. Keep it short: it is in every agent's tool list.
 */
export const PROFILE_GUIDE = [
  "Profiles: full: every tool (default).",
  "builder: files, shell, git, tests; no browser, cannot message agents.",
  "researcher: web, read, browser, read-only bash with network; cannot change files.",
  "reviewer: read, diffs, tests, agents read and send; read-only bash, no network; cannot change files.",
  "read-only: read, git history, tests, web; read-only bash, no network; cannot change files.",
  "If the goal writes files, commits, or pushes, use builder or full.",
].join(" ")

/** How an agent can use bash: without a sandbox, in one, or not at all. */
export type BashMode = "full" | SandboxMode | "none"

/**
 * The file tools and the bash of an agent with `profile` and `limits`. A
 * subagent that its parent gives `bash` runs bash without the sandbox.
 */
export function toolAccess(
  profile: Profile | undefined,
  limits: ToolLimits | undefined
) {
  const removed = removedNames(profile, { limits: limits ?? {} })
  const add = new Set(currentNames(limits?.add))
  const extensions = profile?.extensions && currentNames(profile.extensions)
  // A tool that the parent adds brings its extension.
  const coding =
    !extensions ||
    extensions.includes("coding-tools") ||
    ["read", "write", "edit", "bash"].some((tool) => add.has(tool))
  const has = (tool: string) => coding && !removed.has(tool)
  const bash: BashMode = !has("bash")
    ? "none"
    : add.has("bash")
      ? "full"
      : (profile?.bash ?? "full")
  return { write: has("write"), edit: has("edit"), bash }
}

/**
 * What an agent cannot use of write, edit, and bash, for example "No: write,
 * edit; bash is sandboxed (read-only, no network)". Empty when it has all.
 */
export function missingToolsText(access: ReturnType<typeof toolAccess>) {
  const missing = [
    ...(access.write ? [] : ["write"]),
    ...(access.edit ? [] : ["edit"]),
    ...(access.bash === "none" ? ["bash"] : []),
  ]
  const sandbox =
    access.bash === "sandbox"
      ? "bash is sandboxed (read-only, no network)"
      : access.bash === "sandbox-net"
        ? "bash is sandboxed (read-only, with network)"
        : ""
  if (missing.length === 0)
    return sandbox ? sandbox[0]!.toUpperCase() + sandbox.slice(1) : ""
  return `No: ${missing.join(", ")}${sandbox ? `; ${sandbox}` : ""}`
}

/** Words before a verb that turn its clause into a negation. */
const NEGATION =
  /\b(?:not|never|no|don'?t|doesn'?t|won'?t|shouldn'?t|mustn'?t|cannot|can'?t|without|avoid|instead of)\b/i

/** A place where an order starts: the clause start, or a joining word. */
const ORDER_START = String.raw`(?:^|\b(?:and|then|also|please|finally|you(?:\s+(?:must|should|will|need\s+to|can))?)\s+)`

const EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|json|md|mdx|txt|py|rs|go|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|sh|yaml|yml|toml|ini|cfg|conf|env|css|scss|html|sql|xml|csv|lock"

/**
 * A file path: absolute or relative (`/a`, `./a`, `~/a`), with two or more
 * slashes (`apps/smith/src`), or a file name with a known extension.
 */
const PATH = String.raw`["'\x60]?(?:(?:~|\.{1,2})?\/[\w.@-]+[\w.@/-]*|[\w.@-]+(?:\/[\w.@-]+){2,}\/?|(?:[\w.@-]+\/)*[\w-][\w.-]*\.(?:${EXTENSIONS})\b)`

const GOAL_PATTERNS = [
  // Git: commit, push, merge as orders.
  new RegExp(
    String.raw`${ORDER_START}(git\s+)?(?:commit|push|merge)\b(?!\s+(?:messages?|hash(?:es)?|sha|log|history|notifications?|conflicts?|requests?|base|commits?|access|rights|permissions?)\b)(?![-'])`,
    "i"
  ),
  // Open a pull request.
  new RegExp(
    String.raw`${ORDER_START}(?:(?:open|create|file|submit|raise|make|send)\s+(?:an?\s+|the\s+)?(?:new\s+|draft\s+)?(?:PR|pull\s+request)s?\b|(?:run\s+)?gh\s+pr\s+(?:create|merge)\b)`,
    "i"
  ),
  // A change verb, a short object, and a path.
  new RegExp(
    String.raw`${ORDER_START}(?:create|write|edit|modify|update|save|append|fix|delete|remove|rename|refactor|implement|add|change|apply|move|overwrite|patch|replace)\b(?:\s+(?!(?:for|of|about|on|like|with|than|whether|if|how|what|why)\b)[\w'-]+){0,4}?\s+(?:${PATH})`,
    "i"
  ),
]

/**
 * The words of `goal` that ask to change files or the repository (commit,
 * push, merge, open a PR, or a change verb with a file path), or undefined.
 * It is careful: a verb must be an order (at the start of a clause or after
 * "and", "then", "you must"), and a clause with a negation before the verb
 * ("do not commit") does not count. It does not see a change without a path
 * ("fix the bug").
 */
export function goalChangeIntent(goal: string) {
  // Clauses: sentences, lines, list items, and parts after ";", ":", ",",
  // or "but". A period inside a path does not end a sentence.
  const clauses = goal
    .split(/[.!?](?=\s|$)|[;\n]|[:,](?=\s)|\s[-*]\s|\bbut\b|\(|\)/i)
    .map((clause) => clause.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
    .filter(Boolean)
  for (const clause of clauses)
    for (const pattern of GOAL_PATTERNS) {
      const match = pattern.exec(clause)
      if (!match) continue
      if (NEGATION.test(clause.slice(0, match.index + match[0].length)))
        continue
      return match[0].trim()
    }
  return undefined
}

/**
 * Why a subagent should not start with these tools, or undefined: its
 * profile needs a sandbox that this machine does not have, or its goal
 * changes files and its tools cannot.
 */
export function spawnRefusal(options: {
  goal: string
  profile: Profile | undefined
  limits?: ToolLimits
  /** Whether this machine has the bash sandbox. */
  sandbox: boolean
}) {
  const access = toolAccess(options.profile, options.limits)
  const name = options.profile?.name ?? "full"
  const force = "If this is wrong, call again with force: true."
  if (
    (access.bash === "sandbox" || access.bash === "sandbox-net") &&
    !options.sandbox
  )
    return `Profile ${name} runs bash only in a sandbox, and this machine has none (it needs bubblewrap on Linux or sandbox-exec on macOS), so the subagent would have no bash. Use profile: "builder", or add: ["bash"] for bash without the sandbox. ${force}`
  if (access.write && access.edit && access.bash === "full") return undefined
  const phrase = goalChangeIntent(options.goal)
  if (!phrase) return undefined
  return `The goal asks to change files or the repository ("${phrase}"), but profile ${name} cannot. ${missingToolsText(access)}. Use profile: "builder", or add: ["write", "edit", "bash"]. ${force}`
}

/**
 * Configure a conversation for a profile. `undefined` or `full` clears the
 * profile's choices, so the conversation follows the host defaults again.
 * A subagent always keeps the subagent limits.
 */
export async function applyProfile(
  conversation: Pick<Conversation, "configure" | "agent">,
  registry: RegistryReader,
  profile: Profile | undefined,
  context: Context,
  options: SelectionOptions = {}
) {
  const selection = resolveSelection(registry, profile, options)
  const load = nameList(profile?.loadTools)
  // The deferred tools that the profile loads, and the loaded ones stay.
  let modelTools: { add: ToolRegistration[] } | undefined
  if (load) {
    const loaded = (await conversation.agent(context)).tools
      .filter((tool) => tool.deferred === true)
      .map((tool) => tool.name)
    const snapshot = registry.snapshot()
    const byName = new Map(
      snapshot.tools().map(({ tool }) => [tool.name, tool] as const)
    )
    modelTools = {
      add: [...new Set([...loaded, ...load])].flatMap((name) => {
        const tool = byName.get(name)
        return tool ? [tool] : []
      }),
    }
  }
  await conversation.configure(
    {
      extensions: selection.extensions,
      tools:
        selection.removeTools.length > 0
          ? { remove: selection.removeTools }
          : null,
      instructions: selection.instructions,
      ...(modelTools ? { modelTools } : {}),
    },
    context
  )
}

// -----------------------------------------------------------------------------
// The bash guard of subagents

/** Shell words of a command, split into simple commands at `;`, `&`, `|`, newlines, and `(`. */
function simpleCommands(command: string) {
  const segments: string[][] = []
  let words: string[] = []
  let word = ""
  let quote: string | undefined
  const endWord = () => {
    if (word) words.push(word)
    word = ""
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
  }
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    if (quote) {
      if (char === quote) quote = undefined
      else if (char === "\\" && quote === '"' && index + 1 < command.length)
        word += command[++index]
      else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "\\" && index + 1 < command.length) {
      word += command[++index]
      continue
    }
    if (/\s/.test(char)) {
      if (char === "\n") endSegment()
      else endWord()
      continue
    }
    if (";&|()`{}".includes(char)) {
      endSegment()
      continue
    }
    if (char === "$" && command[index + 1] === "(") {
      endSegment()
      index += 1
      continue
    }
    word += char
  }
  endSegment()
  const result: string[][] = []
  for (const segment of segments) {
    result.push(segment)
    // `bash -c "…"` and `sh -c '…'`: check the inner command too.
    const shell = segment.findIndex((item) =>
      /^(?:.*\/)?(?:ba|z|da|k)?sh$/.test(item)
    )
    const flag = shell >= 0 ? segment.indexOf("-c", shell) : -1
    if (flag >= 0 && segment[flag + 1])
      result.push(...simpleCommands(segment[flag + 1]!))
  }
  return result
}

/** The words of a simple command without leading `VAR=value`, `env`, `command`, `exec`, or `time`. */
function commandWords(words: string[]) {
  let index = 0
  while (index < words.length) {
    const word = words[index]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) index += 1
    else if (["env", "command", "exec", "time", "nohup", "!"].includes(word))
      index += 1
    else break
  }
  return words.slice(index)
}

const PROTECTED_BRANCHES = new Set(["main", "master"])

/** The branch that a refspec writes to, for example `HEAD:main` gives `main`. */
function destination(refspec: string) {
  const target = refspec.replace(/^\+/, "").split(":").at(-1) ?? ""
  return target.replace(/^refs\/heads\//, "")
}

/**
 * Why a `git push` writes to main, or undefined. `currentBranch` reads the
 * branch of a directory, for a push without a refspec.
 */
async function pushToMain(
  words: string[],
  cwd: string,
  currentBranch: (dir: string) => Promise<string | undefined>
) {
  if (words[0] !== "git" && !words[0]?.endsWith("/git")) return undefined
  let index = 1
  let dir = cwd
  while (index < words.length && words[index]!.startsWith("-")) {
    const option = words[index]!
    if (option === "-C" && words[index + 1]) {
      const next = words[index + 1]!
      dir = next.startsWith("/") ? next : `${dir}/${next}`
      index += 2
    } else if (option === "-c" && words[index + 1]) index += 2
    else index += 1
  }
  if (words[index] !== "push") return undefined
  const rest = words.slice(index + 1)
  if (rest.some((word) => word === "--all" || word === "--mirror"))
    return "git push --all and --mirror write to main"
  const positional: string[] = []
  for (let item = 0; item < rest.length; item += 1) {
    const word = rest[item]!
    if (word.startsWith("-")) {
      // Options that take a separate value.
      if (["-o", "--push-option", "--repo", "--receive-pack"].includes(word))
        item += 1
      continue
    }
    positional.push(word)
  }
  const refspecs = positional.slice(1)
  if (refspecs.some((refspec) => PROTECTED_BRANCHES.has(destination(refspec))))
    return "git push to main or master"
  if (
    refspecs.length === 0 ||
    refspecs.some((spec) => /^\+?HEAD$/.test(spec))
  ) {
    const branch = await currentBranch(dir)
    if (branch && PROTECTED_BRANCHES.has(branch))
      return `git push from branch ${branch}`
  }
  return undefined
}

/** True when the words start with the denied command, word by word. */
function startsWith(words: string[], denied: string[]) {
  if (denied.length === 0 || words.length < denied.length) return false
  return denied.every((part, index) => {
    const word = words[index]!
    return index === 0
      ? word === part || word.endsWith(`/${part}`)
      : word === part
  })
}

/**
 * The reason a subagent may not run a command, or undefined. It refuses
 * `git push` to main or master, `sudo`, and the commands in `denyCommands`
 * (each one a command with its first words, for example `npm publish`). It
 * is a guard against mistakes, not a sandbox.
 */
export async function bashGuard(
  command: string,
  options: {
    cwd: string
    denyCommands?: string[]
    currentBranch: (dir: string) => Promise<string | undefined>
  }
) {
  const denied = (options.denyCommands ?? [])
    .map((entry) => entry.trim().split(/\s+/).filter(Boolean))
    .filter((entry) => entry.length > 0)
  for (const segment of simpleCommands(command)) {
    let words = commandWords(segment)
    if (
      words[0] === "sudo" ||
      words[0]?.endsWith("/sudo") ||
      words[0] === "doas"
    )
      return "sudo is not allowed in a subagent"
    for (const entry of denied)
      if (startsWith(words, entry))
        return `\`${entry.join(" ")}\` is not allowed in this subagent`
    words = commandWords(words)
    const push = await pushToMain(words, options.cwd, options.currentBranch)
    if (push) return `${push} is not allowed in a subagent`
  }
  return undefined
}
