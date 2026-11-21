/**
 * The system prompt preview of a new agent, end to end: a Smith server with a
 * fake model, and a project with an AGENTS.md. The preview must show the
 * folder's resources and the profile's tools, and write nothing.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"

import { tempDir } from "./support.ts"

async function startSmith(data: string) {
  const agentDir = join(data, "agent")
  await mkdir(agentDir, { recursive: true })
  await writeFile(join(agentDir, "AGENTS.md"), "Global rule: be brief.\n")
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fake: {
          // No request reaches it: a preview does not call the model.
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "test",
          models: [
            {
              id: "fake",
              name: "Fake",
              contextWindow: 100_000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    })
  )
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir }
  const child = spawn(
    process.execPath,
    [
      "dist/smith-server.mjs",
      "serve",
      "--port",
      "0",
      "--data-dir",
      data,
      "--web-dir",
      "none",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] }
  )
  let log = ""
  child.stdout.on("data", (chunk) => (log += chunk.toString()))
  child.stderr.on("data", (chunk) => (log += chunk.toString()))
  const exited = new Promise<void>((done) => child.once("exit", () => done()))
  let port: number | undefined
  for (let i = 0; i < 150 && !port; i++) {
    try {
      port = JSON.parse(await readFile(join(data, "server.json"), "utf8")).port
    } catch {
      if (child.exitCode !== null) throw new Error(log)
      await new Promise((done) => setTimeout(done, 100))
    }
  }
  assert.ok(port, log)
  return {
    url: `http://127.0.0.1:${port}`,
    agentDir,
    log: () => log,
    async stop() {
      child.kill("SIGTERM")
      await exited
    },
  }
}

/** The number of rows of each table of the database. */
function rowCounts(database: string) {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        (
          db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as {
            n: number
          }
        ).n,
      ])
    )
  } finally {
    db.close()
  }
}

type Preview = {
  ok: boolean
  cwd: string
  sent: boolean
  sections: Array<{
    id: string
    text: string
    files?: Array<{ path: string; scope: string }>
  }>
  tokens: {
    tools: { items: Array<{ name: string }> }
    model?: { id: string; contextWindow?: number }
  }
  preview: { profile: string }
}

void test("the preview shows what a new agent in a folder gets, and writes nothing", async () => {
  const data = await tempDir("smith-preview-")
  const project = await tempDir("smith-preview-project-")
  await writeFile(join(project, "AGENTS.md"), "Project rule: say hi.\n")
  const smith = await startSmith(data)
  try {
    const get = async (path: string, query: Record<string, string>) => {
      const url = new URL(path, smith.url)
      for (const [key, value] of Object.entries(query))
        url.searchParams.set(key, value)
      const response = await fetch(url)
      return { status: response.status, body: (await response.json()) as any }
    }
    const database = join(data, "smith.sqlite")
    const before = rowCounts(database)

    const full = (
      await get("/api/agent/system-prompt/preview", {
        context: "preview-test",
        cwd: project,
      })
    ).body as Preview
    assert.equal(full.ok, true, JSON.stringify(full))
    assert.equal(full.sent, false)
    assert.equal(full.preview.profile, "full")
    // The folder's resources: the global and the project AGENTS.md.
    const context = full.sections.find((s) => s.id === "project_context")
    assert.ok(context, JSON.stringify(full.sections.map((s) => s.id)))
    assert.deepEqual(
      context.files?.map((file) => file.scope),
      ["global", "project"]
    )
    assert.match(context.text, /Project rule: say hi\./)
    assert.match(context.text, /Global rule: be brief\./)
    const cwd = full.sections.find((s) => s.id === "cwd")
    assert.ok(cwd?.text.includes(full.cwd))
    // No empty sections, such as an empty todo list.
    for (const section of full.sections)
      assert.notEqual(section.text.trim(), "", section.id)
    // The default model counts the tokens; the full profile has every tool.
    assert.equal(full.tokens.model?.id, "fake")
    const fullTools = full.tokens.tools.items.map((tool) => tool.name)
    assert.ok(fullTools.includes("bash"), fullTools.join(", "))
    assert.ok(fullTools.includes("write"))

    // A profile takes tools away and adds its instructions.
    const researcher = (
      await get("/api/agent/system-prompt/preview", {
        context: "preview-test",
        cwd: project,
        profile: "researcher",
        model: "fake/fake",
      })
    ).body as Preview
    assert.equal(researcher.preview.profile, "researcher")
    const tools = researcher.tokens.tools.items.map((tool) => tool.name)
    assert.ok(tools.length > 0)
    for (const name of ["bash", "write", "edit"])
      assert.ok(!tools.includes(name), `${name} in ${tools.join(", ")}`)
    assert.match(
      researcher.sections.find((s) => s.id === "instructions")?.text ?? "",
      /You are a researcher/
    )

    // One section, as the text dialog reads it.
    const one = await get("/api/agent/system-prompt/preview", {
      context: "preview-test",
      cwd: project,
      section: "project_context",
      scope: "project",
    })
    assert.match(one.body.text, /Project rule/)
    assert.doesNotMatch(one.body.text, /Global rule/)

    // The exact-count route answers too (estimates for this model).
    const counted = await get("/api/agent/system-prompt/preview/tokens", {
      context: "preview-test",
      cwd: project,
    })
    assert.equal(counted.body.ok, true)
    assert.ok(counted.body.tokens.total.tokens > 0)

    // A file of the preview, without an agent.
    const file = await get("/api/agent/instructions", {
      context: "preview-test",
      cwd: project,
      path: context.files!.find((f) => f.scope === "project")!.path,
    })
    assert.match(file.body.text, /Project rule/)

    // Wrong input.
    const unknown = await get("/api/agent/system-prompt/preview", {
      cwd: project,
      profile: "nope",
    })
    assert.equal(unknown.status, 400)
    const badModel = await get("/api/agent/system-prompt/preview", {
      cwd: project,
      model: "fake/none",
    })
    assert.equal(badModel.status, 400)

    // Nothing was written: no agent, no conversation, no draft.
    assert.deepEqual(rowCounts(database), before)
    const agents = await get("/api/project-agents-index", {})
    assert.ok(
      !JSON.stringify(agents.body).includes(project),
      JSON.stringify(agents.body)
    )
  } catch (error) {
    console.error(smith.log())
    throw error
  } finally {
    await smith.stop()
  }
})
