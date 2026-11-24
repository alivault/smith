/**
 * Finds structure in plain tool output, for the richer views of AI Elements:
 * test results, a stack trace, and the sources of a web search. Each parser
 * is strict: it returns null unless the output clearly has that shape, and
 * the caller then shows the output as it is.
 */

export type TestFailure = { name: string; message?: string }

export type TestSummary = {
  runner: "vitest" | "node" | "jest"
  passed: number
  failed: number
  skipped: number
  total: number
  failures: Array<TestFailure>
}

/** Output with ANSI escape sequences removed. */
export function stripAnsi(text: string) {
  return text.replace(
    // oxlint-disable-next-line no-control-regex
    /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g,
    ""
  )
}

/** At most this many characters are read, so huge output stays cheap. */
const MAX_SCAN = 200_000

function tail(text: string) {
  return text.length > MAX_SCAN ? text.slice(-MAX_SCAN) : text
}

function countIn(line: string, word: string) {
  const match = new RegExp(`(\\d+) ${word}`).exec(line)
  return match ? Number(match[1]) : 0
}

/**
 * The summary of a test run by Vitest (`Tests  1 failed | 5 passed (6)`),
 * the Node test runner (`ℹ tests 3`, `ℹ pass 2`, `ℹ fail 1`), or Jest
 * (`Tests: 1 failed, 5 passed, 6 total`).
 */
export function parseTestSummary(output: string): TestSummary | null {
  const text = stripAnsi(tail(output))
  return parseVitest(text) ?? parseNodeTest(text) ?? parseJest(text)
}

function parseVitest(text: string): TestSummary | null {
  const match = /^\s*Tests\s{2,}(.+?)\s+\((\d+)\)\s*$/m.exec(text)
  if (!match || !/^\s*Test Files\s{2,}/m.test(text)) return null
  const counts = match[1]!
  const failures: Array<TestFailure> = []
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const failed = /^\s*× (.+?)(?: \d+(?:\.\d+)?m?s)?\s*$/.exec(lines[index]!)
    if (!failed) continue
    const next = /^\s*→ (.+)$/.exec(lines[index + 1] ?? "")
    failures.push({
      name: failed[1]!,
      ...(next ? { message: next[1]!.trim() } : {}),
    })
  }
  return {
    runner: "vitest",
    passed: countIn(counts, "passed"),
    failed: countIn(counts, "failed"),
    skipped: countIn(counts, "skipped") + countIn(counts, "todo"),
    total: Number(match[2]),
    failures,
  }
}

function parseNodeTest(text: string): TestSummary | null {
  const read = (key: string) => {
    const match = new RegExp(`^ℹ ${key} (\\d+)\\s*$`, "m").exec(text)
    return match ? Number(match[1]) : undefined
  }
  const total = read("tests")
  const passed = read("pass")
  const failed = read("fail")
  if (total === undefined || passed === undefined || failed === undefined)
    return null
  const failures: Array<TestFailure> = []
  for (const match of text.matchAll(
    /^\s*✖ (.+?)(?: \(\d+(?:\.\d+)?m?s\))?\s*$/gm
  )) {
    const name = match[1]!
    // The runner lists the failures again at the end; keep each one once.
    if (name !== "failing tests:" && !failures.some((f) => f.name === name))
      failures.push({ name })
  }
  return {
    runner: "node",
    passed,
    failed,
    skipped: (read("skipped") ?? 0) + (read("todo") ?? 0),
    total,
    failures,
  }
}

function parseJest(text: string): TestSummary | null {
  const match = /^Tests:\s+(.+?(\d+) total)\s*$/m.exec(text)
  if (!match || !/^Test Suites:\s+/m.test(text)) return null
  const counts = match[1]!
  const failures: Array<TestFailure> = []
  for (const failed of text.matchAll(/^\s*● (.+?)\s*$/gm)) {
    const name = failed[1]!
    if (!failures.some((f) => f.name === name)) failures.push({ name })
  }
  return {
    runner: "jest",
    passed: countIn(counts, "passed"),
    failed: countIn(counts, "failed"),
    skipped: countIn(counts, "skipped") + countIn(counts, "todo"),
    total: Number(match[2]),
    failures,
  }
}

export type StackFrame = {
  raw: string
  fn?: string
  file?: string
  line?: number
  column?: number
  /** A frame of Node itself or of a dependency, shown dimmed. */
  internal: boolean
}

export type StackTraceInfo = {
  type: string
  message: string
  frames: Array<StackFrame>
}

const FRAME = /^\s+at (?:(.+?) \()?(.+?)(?::(\d+))?(?::(\d+))?\)?\s*$/

/**
 * The first JavaScript error with stack frames: an `Error: message` line,
 * then two or more `at …` lines.
 */
export function parseStackTrace(output: string): StackTraceInfo | null {
  const lines = stripAnsi(tail(output)).split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const head =
      /^(?:Uncaught )?([A-Z]\w*(?:Error|Exception))(?: \[\w+\])?: (.+)$/.exec(
        lines[index]!.trim()
      )
    if (!head) continue
    const frames: Array<StackFrame> = []
    for (let at = index + 1; at < lines.length; at += 1) {
      const line = lines[at]!
      if (!/^\s+at /.test(line)) break
      const match = FRAME.exec(line)
      const file = match?.[2]
      frames.push({
        raw: line.trim(),
        ...(match?.[1] ? { fn: match[1] } : {}),
        ...(file ? { file } : {}),
        ...(match?.[3] ? { line: Number(match[3]) } : {}),
        ...(match?.[4] ? { column: Number(match[4]) } : {}),
        internal:
          !file ||
          file.startsWith("node:") ||
          file.includes("/node_modules/") ||
          file === "<anonymous>",
      })
    }
    if (frames.length >= 2) return { type: head[1]!, message: head[2]!, frames }
  }
  return null
}

export type WebSource = { title: string; url: string }

/**
 * The sources in the output of `web_search`: numbered titles, each with
 * its URL on the next line.
 */
export function parseWebSources(output: string): Array<WebSource> {
  const sources: Array<WebSource> = []
  const seen = new Set<string>()
  for (const match of tail(output).matchAll(
    /^\d+\. (.+)\n\s+(https?:\/\/\S+)\s*$/gm
  )) {
    const url = match[2]!
    if (seen.has(url)) continue
    seen.add(url)
    sources.push({ title: match[1]!.trim(), url })
  }
  return sources
}
