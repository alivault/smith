#!/usr/bin/env node
/**
 * Measure how smooth the conversation draws while an agent streams.
 *
 *   node apps/smith/scripts/perf/render-bench.mjs              # 3 runs per mode, 1 per throttled mode
 *       (about 50 s per run; the default modes take about 8 minutes)
 *   node apps/smith/scripts/perf/render-bench.mjs --runs 5 --throttled 2
 *   node apps/smith/scripts/perf/render-bench.mjs --modes normal,follow
 *       modes: normal (auto-scroll off, the default: the prompt pins to the
 *       top and the reply grows below), follow (the "Follow new messages"
 *       setting on), throttled and throttled-follow (4× CPU throttling).
 *       A mode can end in a CSS variant, to test a cause without changing
 *       the app: follow+noshimmer (no shimmer animation), follow+noanim (no
 *       CSS animations or transitions), follow+nospin (no loader spinners).
 *       See CSS_VARIANTS.
 *   node apps/smith/scripts/perf/render-bench.mjs --no-trace   # no Chrome trace (less overhead)
 *   node apps/smith/scripts/perf/render-bench.mjs --no-build   # use the builds as they are
 *   node apps/smith/scripts/perf/render-bench.mjs --headed     # show the browser
 *   node apps/smith/scripts/perf/render-bench.mjs --no-profile # no CPU profile (less overhead)
 *   node apps/smith/scripts/perf/render-bench.mjs --out DIR    # default: /tmp/render-perf
 *   node apps/smith/scripts/perf/render-bench.mjs --shots      # screenshots every 2 s (costs frames)
 *   node apps/smith/scripts/perf/render-bench.mjs --web DIR    # the web build (default: <out>/web)
 *
 * What it does:
 *   1. Builds the server and the web. The web goes to <out>/web with hidden
 *      source maps (the same JavaScript as the product build), so the CPU
 *      profile can name the functions.
 *   2. Starts a fake OpenAI-compatible model in this process, and a Smith of
 *      its own (free port, data folder <out>/data, Pi agent folder
 *      <out>/agent). Your Smith, ~/.smith, and real models are not touched.
 *   3. For each run: starts a new agent and plays SEED_TURNS fast turns, so
 *      the conversation has about 60 items. Then it opens the agent in
 *      Chromium (1440×900), sends one more prompt from the composer, and
 *      the model plays a fixed turn at about 65 tokens/s: thinking, a
 *      markdown reply, a bash tool with 40 lines over 4 s, a 1.5 s gap, more
 *      text, a second tool, and a long final reply with a table and code.
 *   4. While the turn plays, the page records each frame (requestAnimationFrame
 *      deltas, the scroll position of the conversation, DOM mutations, React
 *      commits through a minimal devtools hook), Long Animation Frames, long
 *      tasks, layout shifts, the running CSS animations, each SSE message
 *      (type, size, handler time with the React render that it starts), a
 *      CPU profile (CDP Profiler), and a Chrome trace (style, layout, paint).
 *      The fake model logs its phases. After the turn, the wheel scrolls the
 *      history to the top and back (phase history-scroll).
 *   5. Writes <out>/runs/<mode>-<n>.json (analysis), .raw.json (samples),
 *      .cpuprofile and .trace.json (open them in Chrome DevTools,
 *      Performance), and <out>/summary.md and <out>/summary.json (medians of
 *      the runs, per mode and per phase).
 *
 * Caveats: headless Chrome; the frame sampler reads scrollTop and
 * scrollHeight in each frame (this forces the style and layout of that
 * frame early; the profile names it benchFindViewport); 4× throttling adds
 * 33 ms frames at a regular 500 ms beat that no main thread work explains.
 *
 * Normal and throttled runs alternate, because the machine is often loaded.
 * Needs Chrome (CHROME_BIN, or Google Chrome in /Applications).
 */
import { spawn, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { createServer as createNetServer } from "node:net"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(join(appDir, "server/package.json"))
const { chromium } = require("playwright-core")

const SEED_TURNS = 8
const TOKENS_PER_SECOND = 65
const TOKENS_PER_CHUNK = 2
/** CSS that a mode such as `follow+noshimmer` adds to the page. */
const CSS_VARIANTS = {
  noshimmer: ".shimmer { animation: none !important; }",
  nospin:
    ".animate-spin, svg.lucide-loader-circle { animation: none !important; }",
  noanim:
    "*, *::before, *::after { animation: none !important; transition: none !important; }",
}

const PROMPT = "Build the module index, run the tests, and explain the result."

// ---------------------------------------------------------------------------
// Options

function parseOptions(argv) {
  const value = (flag, fallback) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : fallback
  }
  return {
    runs: Number(value("--runs", 3)),
    throttled: Number(value("--throttled", 1)),
    modes: value("--modes", "normal,follow,throttled,throttled-follow").split(
      ","
    ),
    trace: !argv.includes("--no-trace"),
    build: !argv.includes("--no-build"),
    headed: argv.includes("--headed"),
    profile: !argv.includes("--no-profile"),
    out: resolve(value("--out", "/tmp/render-perf")),
    web: value("--web", undefined),
    shots: argv.includes("--shots"),
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options })
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})`)
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

function findChromium() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  for (const name of ["chromium", "chromium-browser", "google-chrome"]) {
    const found = spawnSync("sh", ["-c", `command -v ${name}`], {
      encoding: "utf8",
    })
    if (found.status === 0) return found.stdout.trim()
  }
  return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
}

// ---------------------------------------------------------------------------
// The scripted turn

const THINKING_1 =
  "The user wants the module index built and the tests run. I should look at the build script first, then run it, and read its output. If the build passes I run the test suite and summarize what changed. The index lives in src/index.ts and the generator walks src/modules. I will start with a short plan so the user knows what happens."

const REPLY_1 = `## Plan

I will build the module index first and then run the tests. The generator is in \`scripts/build-index.ts\`; it walks \`src/modules\` and writes \`src/index.ts\`.

Here is what the build does, step by step:

1. It reads every file in \`src/modules\` that ends in \`.ts\`.
2. It skips test files (\`*.test.ts\`) and files that start with an underscore.
3. It sorts the names, so the output is stable from run to run.
4. It writes one \`export * from\` line for each module.

Some notes before I run it:

- The generator does not delete stale entries by itself, so a removed module can stay in the index until the next full build.
- It uses \`fs.readdirSync\` with \`withFileTypes\`, which is fast enough for a few hundred files.
- The output is formatted with the project formatter, so the diff stays small.

The core of the generator is short:

\`\`\`ts
import { readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export function buildIndex(dir: string, target: string) {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .filter((name) => !name.endsWith(".test.ts") && !name.startsWith("_"))
    .sort()
  const lines = names.map((name) => \`export * from "./modules/\${name.slice(0, -3)}"\`)
  writeFileSync(target, lines.join("\\n") + "\\n")
  return names.length
}
\`\`\`

I will run the build now and watch its output for warnings.
`

const REPLY_2 = `The build passed: all **40 modules** compiled, and the slowest one took less than 100 ms. There were no warnings. Now I run the test suite, which checks the index and the public exports.
`

const THINKING_3 =
  "All 15 tests passed. I should summarize the results with a table and show the one change that matters for the user."

const REPLY_3 = `## Results

The index is up to date and every test passes. Here is a summary of the run:

| Step | Result | Time | Notes |
| --- | --- | --- | --- |
| Build index | 40 modules | 4.1 s | No warnings |
| Type check | Clean | 2.3 s | Strict mode |
| Unit tests | 15 passed | 1.6 s | No skipped tests |
| Lint | Clean | 0.9 s | Two files fixed by the formatter |

### What changed

The only real change is in \`src/index.ts\`: the generator added the two new modules, \`cache-store\` and \`retry-policy\`, and removed the stale entry for \`legacy-client\`. The public API now exports these names:

- \`createCacheStore\` and \`CacheStoreOptions\` from \`cache-store\`
- \`withRetry\`, \`RetryPolicy\`, and \`defaultRetryPolicy\` from \`retry-policy\`

If you want the index to stay current without a manual step, add the generator to the \`prebuild\` script:

\`\`\`json
{
  "scripts": {
    "prebuild": "node scripts/build-index.ts",
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run"
  }
}
\`\`\`

### Next steps

1. Review the diff of \`src/index.ts\`; it has three changed lines.
2. Decide if \`legacy-client\` should also leave the docs, because the README still links to it.
3. Commit the change with the message \`build: update the module index\`.

Nothing else needs your attention. The build is fast, the tests are green, and the output is stable from run to run, so the index will not change again until a module is added or removed.
`

function bashScript(lines, label, slow) {
  const pause = slow ? "; sleep 0.1" : ""
  return label === "build"
    ? `for i in $(seq 1 ${lines}); do echo "[$i/${lines}] build: compiled src/modules/module-$i.ts in $(( (i * 37) % 90 + 10 )) ms"${pause}; done; echo "index: wrote src/index.ts (${lines} exports)"`
    : `for i in $(seq 1 ${lines}); do echo "ok $i - index exports case $i"${pause}; done; echo "# tests ${lines}"; echo "# pass ${lines}"`
}

/** The steps of the turn; a step is the answer after `step` tool results. */
function turnSteps(fast) {
  return [
    {
      thinking: THINKING_1,
      text: REPLY_1,
      tool: { command: bashScript(40, "build", !fast) },
    },
    {
      delayMs: 1500,
      text: REPLY_2,
      tool: { command: bashScript(15, "test", !fast) },
    },
    { delayMs: 1000, thinking: THINKING_3, text: REPLY_3 },
  ]
}

// ---------------------------------------------------------------------------
// The fake model

function tokenize(text) {
  return text.match(/\s*[^\s]{1,4}|\s+/g) ?? []
}

function startFakeModel() {
  const state = { fast: false, log: [] }
  const mark = (step, event) => {
    if (!state.fast) state.log.push({ t: Date.now(), step, event })
  }
  const server = createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw || "{}")
    let closed = false
    response.on("close", () => (closed = true))
    const send = (delta, finish = null) => {
      if (closed) return
      response.write(
        `data: ${JSON.stringify({
          id: "bench",
          object: "chat.completion.chunk",
          created: 0,
          model: "fake-1",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      )
    }
    const stream = async (field, text) => {
      const tokens = tokenize(text)
      const interval = (1000 / TOKENS_PER_SECOND) * TOKENS_PER_CHUNK
      const start = Date.now()
      for (let index = 0; index < tokens.length; index += TOKENS_PER_CHUNK) {
        if (closed) return
        send({
          [field]: tokens.slice(index, index + TOKENS_PER_CHUNK).join(""),
        })
        if (!state.fast) {
          const target = start + (index / TOKENS_PER_CHUNK + 1) * interval
          await sleep(Math.max(0, target - Date.now()))
        }
      }
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    const messages = body.messages ?? []
    if (!body.tools?.length) {
      // A side request, such as the agent name.
      send({ role: "assistant", content: "Render bench" })
      send({}, "stop")
      response.end("data: [DONE]\n\n")
      return
    }
    const lastUser = messages.findLastIndex((m) => m.role === "user")
    const step = Math.min(
      2,
      messages.slice(lastUser + 1).filter((m) => m.role === "tool").length
    )
    const plan = turnSteps(state.fast)[step]
    mark(step, "request")
    if (plan.delayMs && !state.fast) await sleep(plan.delayMs)
    send({ role: "assistant", content: "" })
    if (plan.thinking) {
      mark(step, "thinking_start")
      await stream("reasoning_content", plan.thinking)
      mark(step, "thinking_end")
    }
    mark(step, "text_start")
    await stream("content", plan.text)
    mark(step, "text_end")
    if (plan.tool) {
      send({
        tool_calls: [
          {
            index: 0,
            id: `call_${step}_${Date.now()}`,
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: plan.tool.command }),
            },
          },
        ],
      })
      send({}, "tool_calls")
      mark(step, "tool_call")
    } else {
      send({}, "stop")
      mark(step, "done")
    }
    if (!closed) response.end("data: [DONE]\n\n")
  })
  return new Promise((resolveServer) =>
    server.listen(0, "127.0.0.1", () =>
      resolveServer({ server, state, port: server.address().port })
    )
  )
}

// ---------------------------------------------------------------------------
// Smith

async function startSmith(out, modelPort, webDir) {
  const dataDir = join(out, "data")
  const agentDir = join(out, "agent")
  for (const dir of [dataDir, agentDir])
    rmSync(dir, { recursive: true, force: true })
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-1" })
  )
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          api: "openai-completions",
          apiKey: "bench",
          models: [
            {
              id: "fake-1",
              name: "Fake",
              reasoning: true,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    })
  )
  const port = await freePort()
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir }
  const child = spawn(
    process.execPath,
    [
      join(appDir, "server/dist/smith-server.mjs"),
      "serve",
      "--port",
      String(port),
      "--data-dir",
      dataDir,
      "--web-dir",
      webDir,
      "--no-pty-host",
    ],
    { stdio: ["ignore", "pipe", "pipe"], env }
  )
  let log = ""
  child.stdout.on("data", (chunk) => (log += chunk))
  child.stderr.on("data", (chunk) => (log += chunk))
  const url = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Smith stopped:\n${log}`)
    const ok = await fetch(`${url}/api/system/health`)
      .then((response) => response.ok)
      .catch(() => false)
    if (ok) break
    await sleep(500)
  }
  const cli = (args) =>
    new Promise((done, reject) => {
      const proc = spawn(
        process.execPath,
        [
          join(appDir, "server/dist/smith-server.mjs"),
          "agent",
          ...args,
          "--data-dir",
          dataDir,
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] }
      )
      let stdout = ""
      let stderr = ""
      proc.stdout.on("data", (chunk) => (stdout += chunk))
      proc.stderr.on("data", (chunk) => (stderr += chunk))
      proc.once("exit", (code) =>
        code === 0
          ? done(stdout)
          : reject(new Error(`agent ${args[0]} failed (${code}): ${stderr}`))
      )
    })
  return {
    url,
    cli,
    log: () => log,
    async stop() {
      child.kill("SIGTERM")
      await new Promise((done) => child.once("exit", done))
    },
  }
}

/** A new agent with SEED_TURNS fast turns of history. */
async function seededAgent(smith, model, project, index) {
  model.state.fast = true
  try {
    const started = JSON.parse(
      await smith.cli(["start", project, `Seed run ${index}, turn 1`, "--json"])
    )
    const id = started.id
    await smith.cli(["wait", id, "--timeout", "120"])
    for (let turn = 2; turn <= SEED_TURNS; turn += 1)
      await smith.cli([
        "send",
        id,
        `Seed run ${index}, turn ${turn}`,
        "--wait",
        "--timeout",
        "120",
      ])
    return id
  } finally {
    model.state.fast = false
  }
}

// ---------------------------------------------------------------------------
// The page instruments (runs before the app)

function pageInstruments() {
  const bench = {
    recording: false,
    timeOrigin: performance.timeOrigin,
    frames: [],
    sse: [],
    loaf: [],
    longtasks: [],
    shifts: [],
    commits: [],
  }
  window.__bench = bench
  let mutations = 0
  let commitsThisFrame = 0

  // React calls this hook in production builds too; it only counts commits.
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject() {
      return 1
    },
    checkDCE() {},
    onCommitFiberRoot() {
      if (!bench.recording) return
      commitsThisFrame += 1
      bench.commits.push(performance.now())
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
  }

  let viewport = null
  const benchFindViewport = () => {
    if (viewport?.isConnected && viewport.clientHeight > 0) return viewport
    viewport =
      [
        ...document.querySelectorAll("[data-slot=message-scroller-viewport]"),
      ].find((element) => element.clientHeight > 0) ?? null
    return viewport
  }
  const benchFrame = (now) => {
    if (bench.recording) {
      const element = benchFindViewport()
      bench.frames.push([
        now,
        element ? element.scrollTop : -1,
        element ? element.scrollHeight : -1,
        element ? element.clientHeight : -1,
        mutations,
        commitsThisFrame,
      ])
    }
    mutations = 0
    commitsThisFrame = 0
    requestAnimationFrame(benchFrame)
  }
  requestAnimationFrame(benchFrame)

  // Which CSS animations run, once a second: a running animation that is
  // not composited costs style and paint in every frame.
  bench.animations = []
  setInterval(() => {
    if (!bench.recording) return
    const running = document
      .getAnimations()
      .filter((animation) => animation.playState === "running")
      .map((animation) => {
        const target = animation.effect?.target
        const visible = target?.getClientRects?.().length > 0
        return `${animation.animationName ?? animation.constructor.name} on ${describe(target)}${visible ? "" : " (hidden)"}`
      })
    bench.animations.push({ t: performance.now(), running })
  }, 1000)

  new MutationObserver((records) => {
    mutations += records.length
  }).observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
  })

  const describe = (node) => {
    if (!node || node.nodeType !== 1) return node ? node.nodeName : null
    const slot = node.closest("[data-slot]")?.getAttribute("data-slot")
    const cls = String(node.className?.baseVal ?? node.className ?? "")
    return `${node.tagName.toLowerCase()}${slot ? `[${slot}]` : ""}.${cls
      .split(/\s+/)
      .slice(0, 4)
      .join(".")} "${(node.textContent ?? "").trim().slice(0, 40)}"`
  }
  const observe = (type, handle) => {
    try {
      new PerformanceObserver((list) => {
        if (bench.recording)
          for (const entry of list.getEntries()) handle(entry)
      }).observe({ type, buffered: false })
    } catch {}
  }
  observe("long-animation-frame", (entry) =>
    bench.loaf.push({
      startTime: entry.startTime,
      duration: entry.duration,
      blockingDuration: entry.blockingDuration,
      renderStart: entry.renderStart,
      styleAndLayoutStart: entry.styleAndLayoutStart,
      scripts: entry.scripts.map((script) => ({
        startTime: script.startTime,
        duration: script.duration,
        invoker: script.invoker,
        invokerType: script.invokerType,
        sourceURL: script.sourceURL,
        sourceFunctionName: script.sourceFunctionName,
        sourceCharPosition: script.sourceCharPosition,
        forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
      })),
    })
  )
  observe("longtask", (entry) =>
    bench.longtasks.push({
      startTime: entry.startTime,
      duration: entry.duration,
      attribution: entry.attribution?.map((a) => a.containerType ?? a.name),
    })
  )
  observe("layout-shift", (entry) =>
    bench.shifts.push({
      startTime: entry.startTime,
      value: entry.value,
      hadRecentInput: entry.hadRecentInput,
      sources: (entry.sources ?? []).map((source) => ({
        node: describe(source.node),
        inScroller: Boolean(
          source.node?.closest?.("[data-slot=message-scroller-viewport]")
        ),
        previousRect: source.previousRect?.toJSON(),
        currentRect: source.currentRect?.toJSON(),
      })),
    })
  )

  // Log every SSE message: its type, size, and the time of its handler.
  const NativeEventSource = window.EventSource
  class LoggedEventSource extends NativeEventSource {
    set onmessage(handler) {
      super.onmessage = handler
        ? (event) => {
            const start = performance.now()
            try {
              return handler.call(this, event)
            } finally {
              if (bench.recording) {
                const end = performance.now()
                const entry = {
                  t: start,
                  ms: end - start,
                  bytes: event.data.length,
                }
                // React renders sync updates in a microtask that the handler
                // queued; this one runs after it.
                bench.sse.push(entry)
                queueMicrotask(() =>
                  queueMicrotask(() => {
                    entry.ms = performance.now() - start
                    entry.syncMs = end - start
                    describeSse(entry, event.data)
                  })
                )
              }
            }
          }
        : handler
    }
    get onmessage() {
      return super.onmessage
    }
  }
  const describeSse = (entry, data) => {
    try {
      const payload = JSON.parse(data)
      entry.type = payload.type
      if (payload.type === "conversation_delta")
        entry.ops = payload.operations.map((o) => o.op).join(",")
      if (payload.type === "state_sync") {
        entry.streaming = payload.streaming
        entry.items = payload.items?.length
        entry.patch = payload.itemsPatch
          ? JSON.stringify(payload.itemsPatch).length
          : undefined
        entry.patchItems = payload.itemsPatch?.items?.length
      }
    } catch {}
  }
  window.EventSource = LoggedEventSource
}

/** A busy function to align the CPU profile clock with performance.now(). */
function benchClockMarker() {
  performance.mark("bench-sync")
  const start = performance.now()
  while (performance.now() - start < 30) {
    // busy
  }
  return start
}

// ---------------------------------------------------------------------------
// One run

async function measuredRun(
  browser,
  smith,
  model,
  project,
  options,
  label,
  index
) {
  console.log(`[${label}] seeding agent…`)
  const agentId = await seededAgent(smith, model, project, `${label}-${index}`)
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  })
  const [mode, variant] = label.split("+")
  const follow = mode.endsWith("follow")
  if (variant && !CSS_VARIANTS[variant])
    throw new Error(`Unknown CSS variant: ${variant}`)
  if (variant)
    await context.addInitScript(
      `document.addEventListener("DOMContentLoaded", () => { const style = document.createElement("style"); style.textContent = ${JSON.stringify(CSS_VARIANTS[variant])}; document.head.append(style) })`
    )
  await context.addInitScript(
    `localStorage.setItem("smith-auto-scroll", ${JSON.stringify(follow ? "1" : "0")})`
  )
  await context.addInitScript(`(${pageInstruments.toString()})()`)
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  try {
    await page.goto(`${smith.url}/?agent=${agentId}`)
    await page.waitForSelector("textarea")
    await page.waitForFunction(
      () =>
        document.querySelectorAll("[data-slot=message-scroller-item]").length >
        10
    )
    await page.mouse.move(1300, 120)
    await page.waitForTimeout(2500)
    const throttle = mode.startsWith("throttled") ? 4 : 1
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle })
    await page.click("textarea")
    await page.fill("textarea", PROMPT)
    await page.waitForTimeout(500)
    if (options.trace)
      await browser.startTracing(page, {
        categories: [
          "devtools.timeline",
          "disabled-by-default-devtools.timeline",
          "blink.user_timing",
        ],
      })
    if (options.profile) {
      await cdp.send("Profiler.enable")
      await cdp.send("Profiler.setSamplingInterval", { interval: 500 })
      await cdp.send("Profiler.start")
    }
    const markerStart = await page.evaluate(
      `(${benchClockMarker.toString()})()`
    )
    model.state.log = []
    const sentAt = await page.evaluate(() => {
      window.__bench.recording = true
      return performance.now()
    })
    console.log(`[${label}] turn plays…`)
    await page.keyboard.press("Enter")
    let shooting = options.shots
    const shots = (async () => {
      const dir = join(options.out, "runs", `${label}-${index}-shots`)
      mkdirSync(dir, { recursive: true })
      for (let n = 0; shooting; n += 1) {
        await page.screenshot({
          path: join(dir, `${String(n).padStart(2, "0")}.png`),
        })
        await sleep(2000)
      }
    })()
    await sleep(1000)
    await smith.cli(["wait", agentId, "--timeout", "180"])
    shooting = false
    await shots
    // The end of the turn: final parse, highlight, "Worked for" fold.
    await page.waitForTimeout(4000)
    // Scroll the history up to the top and down again with the wheel, as a
    // person does: rows with content-visibility: auto draw as they come in.
    await page.mouse.move(800, 450)
    const historyAt = await page.evaluate(() => performance.now())
    for (const direction of [-1, 1])
      for (let step = 0; step < 80; step += 1) {
        await page.mouse.wheel(0, direction * 400)
        await sleep(50)
        const edge = await page.evaluate((down) => {
          const element = [
            ...document.querySelectorAll(
              "[data-slot=message-scroller-viewport]"
            ),
          ].find((e) => e.clientHeight > 0)
          if (!element) return true
          return down
            ? element.scrollHeight - element.clientHeight - element.scrollTop <
                2
            : element.scrollTop < 2
        }, direction > 0)
        if (edge) break
      }
    await page.waitForTimeout(500)
    const doneAt = await page.evaluate(() => {
      window.__bench.recording = false
      return performance.now()
    })
    let profile
    if (options.profile) {
      profile = (await cdp.send("Profiler.stop")).profile
      await cdp.send("Profiler.disable")
    }
    let trace
    if (options.trace)
      trace = JSON.parse((await browser.stopTracing()).toString())
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
    const bench = await page.evaluate(() => window.__bench)
    const items = await page.evaluate(
      () =>
        document.querySelectorAll("[data-slot=message-scroller-item]").length
    )
    return {
      label,
      index,
      throttle,
      agentId,
      sentAt,
      historyAt,
      doneAt,
      markerStart,
      items,
      modelLog: model.state.log.map((entry) => ({
        ...entry,
        pageT: entry.t - bench.timeOrigin,
      })),
      bench,
      profile,
      trace,
    }
  } finally {
    await context.close()
  }
}

// ---------------------------------------------------------------------------
// Source maps

const VLQ = Object.fromEntries(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    .split("")
    .map((char, index) => [char, index])
)

function decodeMappings(mappings) {
  const lines = []
  let source = 0
  let sourceLine = 0
  let sourceColumn = 0
  let name = 0
  for (const line of mappings.split(";")) {
    const segments = []
    let column = 0
    for (const segment of line.split(",")) {
      if (!segment) continue
      const values = []
      let value = 0
      let shift = 0
      for (const char of segment) {
        const digit = VLQ[char]
        value += (digit & 31) << shift
        if (digit & 32) shift += 5
        else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1)
          value = 0
          shift = 0
        }
      }
      column += values[0]
      const entry = [column]
      if (values.length >= 4) {
        source += values[1]
        sourceLine += values[2]
        sourceColumn += values[3]
        entry.push(source, sourceLine, sourceColumn)
        if (values.length >= 5) {
          name += values[4]
          entry.push(name)
        }
      }
      segments.push(entry)
    }
    lines.push(segments)
  }
  return lines
}

function createMapper(webDir) {
  const maps = new Map()
  const load = (url) => {
    const file = basename(new URL(url).pathname)
    if (maps.has(file)) return maps.get(file)
    const path = join(webDir, "assets", `${file}.map`)
    const map = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null
    const value = map ? { map, lines: decodeMappings(map.mappings) } : null
    maps.set(file, value)
    return value
  }
  const cache = new Map()
  return (callFrame) => {
    const { url, lineNumber, columnNumber, functionName } = callFrame
    const key = `${url}:${lineNumber}:${columnNumber}:${functionName}`
    if (cache.has(key)) return cache.get(key)
    let result = {
      name: functionName || "(anonymous)",
      file: url ? basename(url) : functionName,
      pkg: url ? "unmapped" : functionName,
    }
    const loaded = url?.includes("/assets/") ? load(url) : null
    const segments = loaded?.lines[lineNumber]
    if (segments) {
      let found
      for (const segment of segments) {
        if (segment[0] > columnNumber) break
        if (segment.length >= 4) found = segment
      }
      if (found) {
        const source = loaded.map.sources[found[1]] ?? "?"
        const content = loaded.map.sourcesContent?.[found[1]]
        const text = content?.split("\n")[found[2]] ?? ""
        const near = text.slice(Math.max(0, found[3] - 80), found[3] + 120)
        const guess =
          (found[4] !== undefined && loaded.map.names[found[4]]) ||
          near.match(/function\s*\*?\s*([\w$]+)/)?.[1] ||
          near.match(
            /([\w$]+)\s*[=:]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/
          )?.[1] ||
          near.match(/([\w$]+)\s*\([^)]*\)\s*\{/)?.[1] ||
          functionName ||
          "(anonymous)"
        const short = source.includes("node_modules/")
          ? source.slice(source.lastIndexOf("node_modules/") + 13)
          : source.replace(/^.*apps\/smith\//, "").replace(/^(\.\.\/)+/, "")
        const pkg = source.includes("node_modules/")
          ? short.startsWith("@")
            ? short.split("/").slice(0, 2).join("/")
            : short.split("/")[0]
          : short.startsWith("src/")
            ? short.split("/").slice(0, 3).join("/")
            : short
        result = { name: guess, file: `${short}:${found[2] + 1}`, pkg }
      }
    }
    cache.set(key, result)
    return result
  }
}

// ---------------------------------------------------------------------------
// Analysis

function quantile(values, q) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

const median = (values) => quantile(values, 0.5)
const sum = (values) => values.reduce((total, value) => total + value, 0)
const round = (value, digits = 1) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : value

/** The phases of the turn, in page time: [{ t, phase }], sorted. */
function phaseMarks(result) {
  const marks = [{ t: result.sentAt, phase: "send" }]
  const sse = result.bench.sse
  for (const entry of result.modelLog) {
    const { step, event, pageT } = entry
    if (event === "request" && step > 0) {
      marks.push({ t: pageT, phase: "tool-end" })
      marks.push({ t: pageT + 300, phase: "gap" })
    }
    if (event === "thinking_start") marks.push({ t: pageT, phase: "thinking" })
    if (event === "text_start") marks.push({ t: pageT, phase: "text" })
    if (event === "tool_call") {
      marks.push({ t: pageT, phase: "tool-start" })
      const output = sse.find(
        (s) => s.t > pageT && s.ops?.includes("updateTool")
      )
      if (output) marks.push({ t: output.t, phase: "tool-output" })
    }
    if (event === "done") {
      marks.push({ t: pageT, phase: "end-settle" })
      marks.push({ t: pageT + 2000, phase: "idle-after" })
    }
  }
  if (result.historyAt)
    marks.push({ t: result.historyAt, phase: "history-scroll" })
  return marks.sort((a, b) => a.t - b.t)
}

function phaseAt(marks, t) {
  let phase = "before"
  for (const mark of marks) {
    if (mark.t > t) break
    phase = mark.phase
  }
  return phase
}

const PHASES = [
  "send",
  "thinking",
  "text",
  "tool-start",
  "tool-output",
  "tool-end",
  "gap",
  "end-settle",
  "idle-after",
  "history-scroll",
]

function analyzeRun(result, mapper) {
  const { bench } = result
  const marks = phaseMarks(result)
  const frames = bench.frames
  const deltas = []
  for (let index = 1; index < frames.length; index += 1) {
    deltas.push({
      t: frames[index][0],
      dt: frames[index][0] - frames[index - 1][0],
    })
  }
  const frameStats = (list) => {
    const dts = list.map((d) => d.dt)
    return {
      frames: dts.length,
      p50: round(quantile(dts, 0.5)),
      p95: round(quantile(dts, 0.95)),
      p99: round(quantile(dts, 0.99)),
      max: round(Math.max(0, ...dts)),
      over16: dts.filter((dt) => dt > 18).length,
      over33: dts.filter((dt) => dt > 33.4).length,
      over50: dts.filter((dt) => dt > 50).length,
      // Frames lost: each delta of n vsyncs loses n - 1.
      dropped: sum(dts.map((dt) => Math.max(0, Math.round(dt / 16.67) - 1))),
    }
  }

  // Scroll: is the view pinned to the bottom while it follows?
  let unpinned = 0
  let maxGap = 0
  const scrollSteps = []
  const growthIntervals = []
  let lastGrowth
  let lastHeight
  for (let index = 0; index < frames.length; index += 1) {
    const [t, top, height, client] = frames[index]
    if (top < 0 || t >= (result.historyAt ?? Infinity)) continue
    const gap = height - client - top
    if (gap > 2) unpinned += 1
    maxGap = Math.max(maxGap, gap)
    if (lastHeight !== undefined && height !== lastHeight) {
      if (lastGrowth !== undefined) growthIntervals.push(t - lastGrowth)
      lastGrowth = t
      scrollSteps.push(Math.abs(height - lastHeight))
    }
    lastHeight = height
  }

  const loafs = bench.loaf
    .filter((entry) => entry.startTime >= result.sentAt - 20)
    .map((entry) => {
      const end = entry.startTime + entry.duration
      const script = sum(entry.scripts.map((s) => s.duration))
      const layout = entry.styleAndLayoutStart
        ? end - entry.styleAndLayoutStart
        : 0
      const render = entry.renderStart ? end - entry.renderStart : 0
      return {
        ...entry,
        phase: phaseAt(marks, entry.startTime),
        script: round(script),
        styleLayout: round(layout),
        renderTotal: round(render),
        trigger: sseIn(bench.sse, entry.startTime - 10, end),
      }
    })

  const worstFrames = [...deltas]
    .sort((a, b) => b.dt - a.dt)
    .slice(0, 10)
    .filter((d) => d.dt > 25)
    .map((d) => ({
      at: round(d.t - d.dt - result.sentAt, 0),
      dt: round(d.dt),
      phase: phaseAt(marks, d.t - d.dt),
      trigger: sseIn(bench.sse, d.t - d.dt - 10, d.t),
    }))

  const shifts = bench.shifts.map((shift) => ({
    ...shift,
    phase: phaseAt(marks, shift.startTime),
  }))

  // The CPU profile: self time per function, per phase and in long frames.
  let cpu
  if (result.profile) cpu = analyzeProfile(result, marks, loafs, mapper)

  const trace = result.trace ? analyzeTrace(result, marks) : undefined
  const turnEnd = result.historyAt ?? result.doneAt
  const turnLongTasks = bench.longtasks.filter((l) => l.startTime < turnEnd)
  const turnLoafs = loafs.filter((l) => l.startTime < turnEnd)
  const turnShifts = shifts.filter((s) => s.startTime < turnEnd)

  // How often the conversation visibly changes: frames with DOM mutations.
  const updateIntervals = []
  let lastUpdate
  for (const [t, , , , mutations] of frames) {
    if (!mutations) continue
    if (lastUpdate !== undefined) updateIntervals.push(t - lastUpdate)
    lastUpdate = t
  }
  // While the history scrolls: how often the content height changes (rows
  // with content-visibility: auto get their real height), and by how much.
  const historyFrames = frames.filter(
    ([t]) => result.historyAt && t >= result.historyAt
  )
  let historyHeightChanges = 0
  let historyHeightPx = 0
  for (let index = 1; index < historyFrames.length; index += 1) {
    const change = historyFrames[index][2] - historyFrames[index - 1][2]
    if (change) {
      historyHeightChanges += 1
      historyHeightPx += Math.abs(change)
    }
  }
  const appends = bench.sse.filter((s) => s.ops?.startsWith("appendBlock"))
  const appendIntervals = appends.slice(1).map((s, i) => s.t - appends[i].t)

  const perPhase = {}
  for (const phase of PHASES) {
    const inPhase = deltas.filter((d) => phaseAt(marks, d.t) === phase)
    const phaseStart = marks.find((m) => m.phase === phase)?.t
    if (!inPhase.length) continue
    const phaseLoafs = loafs.filter((l) => l.phase === phase)
    const phaseSse = bench.sse.filter((s) => phaseAt(marks, s.t) === phase)
    const seconds = sum(inPhase.map((d) => d.dt)) / 1000
    perPhase[phase] = {
      startsAt: round((phaseStart ?? 0) - result.sentAt, 0),
      seconds: round(seconds, 2),
      ...frameStats(inPhase),
      loafCount: phaseLoafs.length,
      loafBlockingMs: round(sum(phaseLoafs.map((l) => l.blockingDuration))),
      loafMaxMs: round(Math.max(0, ...phaseLoafs.map((l) => l.duration))),
      cls: round(
        sum(shifts.filter((s) => s.phase === phase).map((s) => s.value)),
        4
      ),
      commits: bench.commits.filter((c) => phaseAt(marks, c) === phase).length,
      sse: phaseSse.length,
      sseHandlerMs: round(sum(phaseSse.map((s) => s.ms))),
      sseHandlerMaxMs: round(Math.max(0, ...phaseSse.map((s) => s.ms))),
      cpuBusyMs: cpu?.perPhase[phase]?.busy,
      cpuTop: cpu?.perPhase[phase]?.top,
      styleMs: trace?.perPhase[phase]?.UpdateLayoutTree,
      layoutMs: trace?.perPhase[phase]?.Layout,
      paintMs: round(
        (trace?.perPhase[phase]?.PrePaint ?? 0) +
          (trace?.perPhase[phase]?.Paint ?? 0) +
          (trace?.perPhase[phase]?.Layerize ?? 0)
      ),
      taskMs: trace?.perPhase[phase]?.RunTask,
      trace: trace?.perPhase[phase],
    }
  }

  const sseByType = {}
  for (const entry of bench.sse) {
    const key = entry.ops ? `${entry.type}:${entry.ops}` : entry.type
    sseByType[key] ??= { count: 0, bytes: 0, handlerMs: [], maxMs: 0 }
    sseByType[key].count += 1
    sseByType[key].bytes += entry.bytes
    sseByType[key].handlerMs.push(entry.ms)
    sseByType[key].maxMs = Math.max(sseByType[key].maxMs, entry.ms)
  }
  for (const value of Object.values(sseByType)) {
    value.p50Ms = round(median(value.handlerMs), 2)
    value.totalMs = round(sum(value.handlerMs))
    value.maxMs = round(value.maxMs)
    delete value.handlerMs
  }

  return {
    label: result.label,
    index: result.index,
    throttle: result.throttle,
    items: result.items,
    durationS: round((turnEnd - result.sentAt) / 1000, 1),
    // The turn only; the history scroll is its own phase.
    overall: {
      ...frameStats(deltas.filter((d) => d.t < turnEnd)),
      longTasks: turnLongTasks.length,
      longTaskTotalMs: round(sum(turnLongTasks.map((l) => l.duration))),
      longTaskMaxMs: round(
        Math.max(0, ...turnLongTasks.map((l) => l.duration))
      ),
      loafCount: turnLoafs.length,
      loafBlockingMs: round(sum(turnLoafs.map((l) => l.blockingDuration))),
      cls: round(sum(turnShifts.map((s) => s.value)), 4),
      clsNoInput: round(
        sum(turnShifts.filter((s) => !s.hadRecentInput).map((s) => s.value)),
        4
      ),
      shifts: turnShifts.length,
      commits: bench.commits.filter((t) => t < turnEnd).length,
      sse: bench.sse.length,
      sseHandlerMs: round(sum(bench.sse.map((s) => s.ms))),
      unpinnedFrames: unpinned,
      maxGapPx: round(maxGap, 0),
      updateIntervalP50Ms: round(median(updateIntervals), 0),
      historyHeightChanges,
      historyHeightPx: round(historyHeightPx, 0),
      appendIntervalP50Ms: round(median(appendIntervals), 0),
      appendCharsP50: round(median(appends.map((s) => s.bytes)), 0),
      styleMs: trace?.total.UpdateLayoutTree,
      layoutMs: trace?.total.Layout,
      paintMs: round(
        (trace?.total.PrePaint ?? 0) +
          (trace?.total.Paint ?? 0) +
          (trace?.total.Layerize ?? 0)
      ),
      taskMs: trace?.total.RunTask,
      traceTotals: trace?.total,
      biggestLayouts: trace?.biggest,
      growthIntervalP50Ms: round(median(growthIntervals), 0),
      growthIntervalP95Ms: round(quantile(growthIntervals, 0.95), 0),
      growthStepP50Px: round(median(scrollSteps), 0),
      growthStepP95Px: round(quantile(scrollSteps, 0.95), 0),
      cpuTop: cpu?.top,
      cpuByPackage: cpu?.byPackage,
      cpuInLongFramesTop: cpu?.inLong,
      cpuBySse: cpu?.bySse,
    },
    perPhase,
    sseByType,
    worstFrames,
    animations: runningAnimations(bench, marks),
    worstLoafs: [...loafs]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 12)
      .map((l) => ({
        at: round(l.startTime - result.sentAt, 0),
        phase: l.phase,
        duration: round(l.duration),
        blocking: round(l.blockingDuration),
        script: l.script,
        styleLayout: l.styleLayout,
        trigger: l.trigger,
        cpuTop: l.cpuTop,
        scripts: l.scripts
          .sort((a, b) => b.duration - a.duration)
          .slice(0, 3)
          .map((s) => ({
            invoker: s.invoker,
            duration: round(s.duration),
            fn: s.sourceFunctionName,
            forcedLayout: round(s.forcedStyleAndLayoutDuration),
          })),
      })),
    worstShifts: [...shifts]
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
      .map((s) => ({
        at: round(s.startTime - result.sentAt, 0),
        phase: s.phase,
        value: round(s.value, 4),
        hadRecentInput: s.hadRecentInput,
        sources: s.sources.slice(0, 3).map((source) => ({
          node: source.node,
          inScroller: source.inScroller,
          dy:
            source.previousRect && source.currentRect
              ? round(source.currentRect.y - source.previousRect.y, 0)
              : undefined,
          dh:
            source.previousRect && source.currentRect
              ? round(source.currentRect.height - source.previousRect.height, 0)
              : undefined,
        })),
      })),
    phases: marks.map((m) => ({ ...m, at: round(m.t - result.sentAt, 0) })),
  }
}

/** The running CSS animations: in how many 1 s samples, and in which phases. */
function runningAnimations(bench, marks) {
  const seen = {}
  for (const sample of bench.animations ?? [])
    for (const name of sample.running) {
      seen[name] ??= { samples: 0, phases: [] }
      seen[name].samples += 1
      const phase = phaseAt(marks, sample.t)
      if (!seen[name].phases.includes(phase)) seen[name].phases.push(phase)
    }
  return Object.entries(seen)
    .sort((a, b) => b[1].samples - a[1].samples)
    .map(([name, value]) => ({ name, ...value }))
}

/** The SSE message with the slowest handler in [from, to]. */
function sseIn(sse, from, to) {
  const entries = sse.filter((s) => s.t >= from && s.t <= to)
  if (!entries.length) return undefined
  const entry = entries.reduce((a, b) => (b.ms > a.ms ? b : a))
  const name = entry.ops
    ? `${entry.type}:${entry.ops}`
    : `${entry.type}${entry.patchItems !== undefined ? ` (patch ${entry.patchItems} items)` : ""}${entry.streaming !== undefined ? ` streaming=${entry.streaming}` : ""}`
  return `${name}, ${entry.bytes} B, handler ${round(entry.ms)} ms`
}

function analyzeProfile(result, marks, loafs, mapper) {
  const { profile, bench } = result
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  // Align: the first sample in benchClockMarker is at markerStart.
  let t = profile.startTime
  const times = []
  for (const delta of profile.timeDeltas) {
    t += delta
    times.push(t / 1000)
  }
  const markerIndex = profile.samples.findIndex(
    (id) => nodes.get(id)?.callFrame.functionName === "benchClockMarker"
  )
  const offset =
    markerIndex >= 0 ? times[markerIndex] - result.markerStart : undefined
  const toPage = (profileMs) =>
    offset === undefined ? profileMs : profileMs - offset
  const longWindows = loafs.map((l) => [
    l.startTime,
    l.startTime + l.duration,
    l,
  ])
  const top = new Map()
  const byPackage = new Map()
  const inLong = new Map()
  const perPhase = {}
  const bySse = {}
  const sse = [...bench.sse].sort((a, b) => a.t - b.t)
  let ssePointer = 0
  const add = (map, key, ms) => map.set(key, (map.get(key) ?? 0) + ms)
  for (let index = 0; index < profile.samples.length - 1; index += 1) {
    const at = toPage(times[index])
    if (at < result.sentAt || at > result.doneAt) continue
    const ms = times[index + 1] - times[index]
    const node = nodes.get(profile.samples[index])
    const fn = mapper(node.callFrame)
    if (fn.name === "(idle)") continue
    const key = `${fn.name} (${fn.file})`
    add(top, key, ms)
    add(byPackage, fn.pkg, ms)
    const phase = phaseAt(marks, at)
    perPhase[phase] ??= { busy: 0, top: new Map() }
    perPhase[phase].busy += ms
    add(perPhase[phase].top, key, ms)
    while (
      ssePointer < sse.length &&
      sse[ssePointer].t + sse[ssePointer].ms < at
    )
      ssePointer += 1
    const inSse = sse[ssePointer]
    if (inSse && inSse.t <= at) {
      const type = inSse.ops ? `${inSse.type}:${inSse.ops}` : inSse.type
      bySse[type] ??= { ms: 0, top: new Map() }
      bySse[type].ms += ms
      add(bySse[type].top, key, ms)
    }
    const window = longWindows.find(([start, end]) => at >= start && at <= end)
    if (window) {
      add(inLong, key, ms)
      window[2].cpu ??= new Map()
      add(window[2].cpu, key, ms)
    }
  }
  const list = (map, count) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([name, ms]) => ({ name, ms: round(ms) }))
  for (const loaf of loafs) {
    loaf.cpuTop = loaf.cpu ? list(loaf.cpu, 5) : undefined
    delete loaf.cpu
  }
  for (const value of Object.values(perPhase)) {
    value.busy = round(value.busy)
    value.top = list(value.top, 8)
  }
  void bench
  for (const value of Object.values(bySse)) {
    value.ms = round(value.ms)
    value.top = list(value.top, 10)
  }
  return {
    bySse,
    aligned: offset !== undefined,
    top: list(top, 30),
    byPackage: list(byPackage, 20),
    inLong: list(inLong, 25),
    perPhase,
  }
}

/**
 * The Chrome trace: main thread time per event name (style, layout, paint,
 * tasks), per phase, and the biggest layouts and style recalcs.
 */
function analyzeTrace(result, marks) {
  const events = result.trace.traceEvents ?? result.trace
  const sync = events.find((e) => e.name === "bench-sync")
  if (!sync) return undefined
  const main = events.find(
    (e) =>
      e.ph === "M" &&
      e.name === "thread_name" &&
      e.pid === sync.pid &&
      e.args?.name === "CrRendererMain"
  )
  const tid = main?.tid ?? sync.tid
  const offset = sync.ts / 1000 - result.markerStart
  const toPage = (ts) => ts / 1000 - offset
  const NAMES = new Set([
    "RunTask",
    "UpdateLayoutTree",
    "Layout",
    "PrePaint",
    "Paint",
    "Layerize",
    "Commit",
    "FunctionCall",
    "FireAnimationFrame",
    "TimerFire",
    "EventDispatch",
    "MajorGC",
    "MinorGC",
    "V8.GC_MC_BACKGROUND_MARKING",
    "HitTest",
    "ParseHTML",
    "IntersectionObserverController::computeIntersections",
    "ResizeObserver::BroadcastObservations",
    "UpdateLayer",
    "ScrollLayer",
    "RasterTask",
  ])
  const total = {}
  const perPhase = {}
  const big = []
  const open = new Map()
  const add = (name, at, dur, args) => {
    if (at < result.sentAt || at > result.doneAt) return
    const phase = phaseAt(marks, at)
    if (phase !== "history-scroll") total[name] = (total[name] ?? 0) + dur
    perPhase[phase] ??= {}
    perPhase[phase][name] = (perPhase[phase][name] ?? 0) + dur
    if ((name === "Layout" || name === "UpdateLayoutTree") && dur > 4)
      big.push({
        at: round(at - result.sentAt, 0),
        phase,
        name,
        ms: round(dur),
        dirty: args?.beginData?.dirtyObjects,
        totalObjects: args?.beginData?.totalObjects,
        elements: args?.elementCount ?? args?.beginData?.elementCount,
      })
  }
  for (const event of events) {
    if (event.pid !== sync.pid || event.tid !== tid) continue
    if (!NAMES.has(event.name)) continue
    if (event.ph === "X")
      add(event.name, toPage(event.ts), (event.dur ?? 0) / 1000, event.args)
    else if (event.ph === "B") open.set(event.name, event)
    else if (event.ph === "E" && open.has(event.name)) {
      const begin = open.get(event.name)
      open.delete(event.name)
      add(event.name, toPage(begin.ts), (event.ts - begin.ts) / 1000, {
        ...begin.args,
        ...event.args,
      })
    }
  }
  const rounded = (map) =>
    Object.fromEntries(
      Object.entries(map)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, round(v)])
    )
  return {
    total: rounded(total),
    perPhase: Object.fromEntries(
      Object.entries(perPhase).map(([k, v]) => [k, rounded(v)])
    ),
    biggest: big.sort((a, b) => b.ms - a.ms).slice(0, 15),
  }
}

// ---------------------------------------------------------------------------
// Summary

const SUMMARY_KEYS = [
  ["durationS", "turn length (s)"],
  ["p50", "frame p50 (ms)"],
  ["p95", "frame p95 (ms)"],
  ["p99", "frame p99 (ms)"],
  ["max", "frame max (ms)"],
  ["over16", "frames >16.7 ms (>18)"],
  ["over33", "frames >33 ms"],
  ["over50", "frames >50 ms"],
  ["dropped", "dropped frames"],
  ["longTasks", "long tasks"],
  ["longTaskTotalMs", "long task total (ms)"],
  ["longTaskMaxMs", "long task max (ms)"],
  ["loafCount", "long animation frames"],
  ["loafBlockingMs", "LoAF blocking (ms)"],
  ["cls", "CLS (all)"],
  ["clsNoInput", "CLS (no recent input)"],
  ["commits", "React commits"],
  ["sse", "SSE messages"],
  ["sseHandlerMs", "SSE handler total (ms)"],
  ["unpinnedFrames", "frames not pinned to bottom"],
  ["maxGapPx", "max gap to bottom (px)"],
  ["updateIntervalP50Ms", "DOM update interval p50 (ms)"],
  ["historyHeightChanges", "history scroll: content height changes"],
  ["historyHeightPx", "history scroll: sum of height changes (px)"],
  ["appendIntervalP50Ms", "text delta interval p50 (ms)"],
  ["appendCharsP50", "text delta size p50 (bytes of JSON)"],
  ["taskMs", "main thread tasks (ms, trace)"],
  ["styleMs", "style recalc (ms, trace)"],
  ["layoutMs", "layout (ms, trace)"],
  ["paintMs", "prepaint+paint+layerize (ms, trace)"],
  ["growthIntervalP50Ms", "content height change interval p50 (ms)"],
  ["growthStepP50Px", "content growth step p50 (px)"],
  ["growthStepP95Px", "content growth step p95 (px)"],
]

function summarize(analyses) {
  const modes = {}
  for (const analysis of analyses) {
    modes[analysis.label] ??= []
    modes[analysis.label].push(analysis)
  }
  const summary = {}
  for (const [mode, list] of Object.entries(modes)) {
    const overall = {}
    for (const [key] of SUMMARY_KEYS)
      overall[key] = round(
        median(
          list.map((a) => (key === "durationS" ? a.durationS : a.overall[key]))
        ),
        key.startsWith("cls") ? 4 : 1
      )
    const perPhase = {}
    for (const phase of PHASES) {
      const present = list.filter((a) => a.perPhase[phase])
      if (!present.length) continue
      perPhase[phase] = {}
      for (const key of [
        "seconds",
        "p50",
        "p95",
        "max",
        "over16",
        "over33",
        "over50",
        "dropped",
        "loafCount",
        "loafBlockingMs",
        "cls",
        "commits",
        "sse",
        "sseHandlerMs",
        "sseHandlerMaxMs",
        "cpuBusyMs",
        "taskMs",
        "styleMs",
        "layoutMs",
        "paintMs",
      ])
        perPhase[phase][key] = round(
          median(present.map((a) => a.perPhase[phase][key] ?? 0)),
          key === "cls" ? 4 : 1
        )
    }
    summary[mode] = { runs: list.length, overall, perPhase }
  }
  return summary
}

function markdown(summary, analyses) {
  const modes = Object.keys(summary)
  const lines = ["# Render bench", ""]
  lines.push(
    `Runs: ${modes.map((m) => `${m} ${summary[m].runs}`).join(", ")}. Values are medians of the runs.`,
    ""
  )
  lines.push(`| metric | ${modes.join(" | ")} |`)
  lines.push(`| --- | ${modes.map(() => "---").join(" | ")} |`)
  for (const [key, label] of SUMMARY_KEYS)
    lines.push(
      `| ${label} | ${modes.map((m) => summary[m].overall[key]).join(" | ")} |`
    )
  for (const mode of modes) {
    lines.push("", `## Phases (${mode})`, "")
    const cols = [
      "seconds",
      "p95",
      "max",
      "over33",
      "over50",
      "dropped",
      "loafBlockingMs",
      "cls",
      "commits",
      "sse",
      "sseHandlerMs",
      "cpuBusyMs",
      "taskMs",
      "styleMs",
      "layoutMs",
      "paintMs",
    ]
    lines.push(`| phase | ${cols.join(" | ")} |`)
    lines.push(`| --- | ${cols.map(() => "---").join(" | ")} |`)
    for (const [phase, values] of Object.entries(summary[mode].perPhase))
      lines.push(`| ${phase} | ${cols.map((c) => values[c]).join(" | ")} |`)
  }
  for (const analysis of analyses) {
    lines.push("", `## Run ${analysis.label}-${analysis.index}`, "")
    lines.push(
      "SSE messages (count, total bytes, handler p50 / max / total ms):",
      ""
    )
    for (const [type, v] of Object.entries(analysis.sseByType).sort(
      (a, b) => b[1].totalMs - a[1].totalMs
    ))
      lines.push(
        `- ${type}: ${v.count}, ${v.bytes} B, ${v.p50Ms} / ${v.maxMs} / ${v.totalMs}`
      )
    lines.push("", "Running CSS animations (1 s samples; phases):", "")
    for (const a of analysis.animations ?? [])
      lines.push(`- ${a.name}: ${a.samples}; ${a.phases.join(", ")}`)
    lines.push("", "Worst frames (rAF delta):", "")
    for (const f of analysis.worstFrames)
      lines.push(
        `- ${f.at} ms, ${f.phase}: ${f.dt} ms; ${f.trigger ?? "no SSE in the frame"}`
      )
    lines.push("", "Worst long animation frames:", "")
    for (const loaf of analysis.worstLoafs.slice(0, 8))
      lines.push(
        `- ${loaf.at} ms, ${loaf.phase}: ${loaf.duration} ms (script ${loaf.script}, style+layout ${loaf.styleLayout}; ${loaf.scripts.map((x) => `${x.invoker} ${x.duration}`).join(", ")}); SSE: ${loaf.trigger ?? "-"}; ${(
          loaf.cpuTop ?? []
        )
          .slice(0, 3)
          .map((c) => `${c.name} ${c.ms}`)
          .join(", ")}`
      )
    if (analysis.overall.cpuTop) {
      lines.push("", "CPU self time by package (ms):", "")
      lines.push(
        analysis.overall.cpuByPackage
          .slice(0, 12)
          .map((c) => `${c.name} ${c.ms}`)
          .join(" · ")
      )
      lines.push(
        "",
        "CPU in SSE handlers (with their React render), top functions (ms):",
        ""
      )
      for (const [type, v] of Object.entries(
        analysis.overall.cpuBySse ?? {}
      ).sort((a, b) => b[1].ms - a[1].ms))
        lines.push(
          `- ${type}: ${v.ms}: ${v.top
            .slice(0, 6)
            .map((c) => `${c.name.replace(/ \(.*\/(?=[^/]+\))/, " (")} ${c.ms}`)
            .join(", ")}`
        )
      lines.push("", "CPU self time in long frames, top functions (ms):", "")
      for (const c of analysis.overall.cpuInLongFramesTop.slice(0, 12))
        lines.push(`- ${c.name}: ${c.ms}`)
    }
    if (analysis.overall.biggestLayouts?.length) {
      lines.push("", "Biggest style recalcs and layouts (trace):", "")
      for (const l of analysis.overall.biggestLayouts.slice(0, 8))
        lines.push(
          `- ${l.at} ms, ${l.phase}: ${l.name} ${l.ms} ms${l.dirty !== undefined ? ` (dirty ${l.dirty}/${l.totalObjects} objects)` : ""}${l.elements !== undefined ? ` (${l.elements} elements)` : ""}`
        )
    }
    lines.push("", "Biggest layout shifts:", "")
    for (const shift of analysis.worstShifts.slice(0, 5))
      lines.push(
        `- ${shift.at} ms, ${shift.phase}: ${shift.value}${shift.hadRecentInput ? " (recent input)" : ""}; ${shift.sources
          .map((s) => `${s.node} dy ${s.dy} dh ${s.dh}`)
          .join("; ")}`
      )
  }
  return `${lines.join("\n")}\n`
}

// ---------------------------------------------------------------------------

async function main() {
  const options = parseOptions(process.argv.slice(2))
  mkdirSync(join(options.out, "runs"), { recursive: true })
  const webDir = resolve(options.web ?? join(options.out, "web"))
  if (options.build) {
    console.log("Building the server and the web (with source maps)…")
    run("pnpm", ["--filter", "@smith/server", "build"], { cwd: appDir })
    run(
      "pnpm",
      [
        "exec",
        "vp",
        "build",
        "--sourcemap",
        "hidden",
        "--outDir",
        webDir,
        "--emptyOutDir",
      ],
      { cwd: appDir }
    )
  }
  const project = join(realpathSync(options.out), "project")
  mkdirSync(project, { recursive: true })
  if (!existsSync(join(project, ".git")))
    run("git", ["init", "-q"], { cwd: project })
  writeFileSync(join(project, "README.md"), "# Bench project\n")

  const model = await startFakeModel()
  const smith = await startSmith(realpathSync(options.out), model.port, webDir)
  console.log(`Bench Smith: ${smith.url}`)
  await fetch(`${smith.url}/api/sidebar-state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projects: [project] }),
  })
  const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: !options.headed,
  })
  const order = []
  for (let i = 0; i < Math.max(options.runs, options.throttled); i += 1)
    for (const mode of options.modes)
      if (i < (mode.startsWith("throttled") ? options.throttled : options.runs))
        order.push(mode)
  const counts = {}
  const analyses = []
  const mapper = createMapper(webDir)
  try {
    for (const label of order) {
      counts[label] = (counts[label] ?? 0) + 1
      const result = await measuredRun(
        browser,
        smith,
        model,
        project,
        options,
        label,
        counts[label]
      )
      const name = `${label}-${counts[label]}`
      if (result.profile)
        writeFileSync(
          join(options.out, "runs", `${name}.cpuprofile`),
          JSON.stringify(result.profile)
        )
      if (result.trace)
        writeFileSync(
          join(options.out, "runs", `${name}.trace.json`),
          JSON.stringify(result.trace)
        )
      const { profile: _profile, trace: _trace, ...raw } = result
      writeFileSync(
        join(options.out, "runs", `${name}.raw.json`),
        JSON.stringify(raw)
      )
      const analysis = analyzeRun(result, mapper)
      writeFileSync(
        join(options.out, "runs", `${name}.json`),
        JSON.stringify(analysis, null, 2)
      )
      analyses.push(analysis)
      const o = analysis.overall
      console.log(
        `[${name}] ${analysis.durationS} s, frames p95 ${o.p95} ms, >33 ms ${o.over33}, >50 ms ${o.over50}, dropped ${o.dropped}, LoAF blocking ${o.loafBlockingMs} ms, CLS ${o.cls}, commits ${o.commits}`
      )
    }
  } finally {
    await browser.close()
    await smith.stop()
    model.server.close()
  }
  const summary = summarize(analyses)
  writeFileSync(
    join(options.out, "summary.json"),
    JSON.stringify(summary, null, 2)
  )
  writeFileSync(join(options.out, "summary.md"), markdown(summary, analyses))
  console.log(`\nDone. See ${join(options.out, "summary.md")}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
