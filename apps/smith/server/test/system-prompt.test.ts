import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"

import { getCurrentSystemPrompt, type Message } from "@earendil-works/pi-ai"
import { createRegistry, Harness } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"

import { AgentMetaDoc, publicId } from "../src/core/agents.ts"
import { executionEnv } from "../src/core/env.ts"
import { ResourceCache } from "../src/core/resources.ts"
import { systemPromptOf } from "../src/core/system-prompt.ts"
import { createPromptExtension } from "../src/extensions/prompt.ts"
import { createTodoExtension } from "../src/extensions/todo.ts"
import { ctx, openHarness, tempDir, TEST_MODEL } from "./support.ts"

/** A project folder with an AGENTS.md, and an agent folder with one. */
async function folders() {
  const dir = await tempDir("smith-prompt-test-")
  const project = join(dir, "project")
  const agentDir = join(dir, "agent")
  await mkdir(project, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await writeFile(join(project, "AGENTS.md"), "Project rule: say hi.\n")
  await writeFile(join(agentDir, "AGENTS.md"), "Global rule: be brief.\n")
  return { dir, project, agentDir }
}

void test("the system prompt lists the sections the model gets, in order", async () => {
  const { dir, project, agentDir } = await folders()
  const resources = new ResourceCache(agentDir)
  const received: Message[][] = []
  const { createCodingTools } = await import("@earendil-works/pi-durable/tools")
  const harness = await openHarness(
    join(dir, "db.sqlite"),
    [
      createPromptExtension(resources),
      createCodingTools(),
      createTodoExtension(),
    ],
    (messages) => {
      received.push([...messages])
      return { text: "hi" }
    },
    project
  )
  try {
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { cwd: project, model: TEST_MODEL, instructions: "Be kind." },
      },
      ctx
    )
    const promptOf = async () => {
      const agent = await conversation.agent(ctx)
      return systemPromptOf({
        cwd: project,
        messages: (await conversation.context(ctx)).messages,
        agent,
        env: () => executionEnv(agent.cwd),
        read: harness,
        conversationId: conversation.id,
        resources: await resources.get(project),
        agentDir,
        context: ctx,
      })
    }

    // Before the first request: rendered as the request will render it.
    const preview = await promptOf()
    assert.equal(preview.sent, false)
    const ids = preview.sections.map((section) => section.id)
    // Skills of the machine may come in; the order of the others is fixed.
    assert.deepEqual(
      ids.filter((id) => id !== "skills"),
      ["preamble", "rules", "project_context", "cwd", "instructions"]
    )
    const [preamble, rules] = preview.sections
    assert.equal(preamble?.tagged, false)
    assert.equal(preamble?.extension, "smith")
    assert.match(preamble?.text ?? "", /^You are an expert coding assistant/)
    assert.equal(rules?.tagged, true)
    assert.match(rules?.text ?? "", /^<rules>\n- Use bash/)
    const context = preview.sections.find(
      (section) => section.id === "project_context"
    )
    assert.deepEqual(
      context?.files?.map(({ path, scope }) => [path.split("/").at(-2), scope]),
      [
        ["agent", "global"],
        ["project", "project"],
      ]
    )
    const instructions = preview.sections.at(-1)
    assert.equal(instructions?.title, "Agent instructions")
    assert.equal(instructions?.extension, undefined)
    assert.equal(
      instructions?.text,
      "<instructions>\nBe kind.\n</instructions>"
    )
    assert.equal(
      preview.text,
      preview.sections.map((section) => section.text).join("\n\n")
    )

    // After a request: replayed from the transcript, exactly as sent.
    await (
      await conversation.submit({ type: "input", content: "hello" }, ctx)
    ).wait(ctx)
    const sent = await promptOf()
    assert.equal(sent.sent, true)
    assert.equal(sent.updates, 0)
    assert.equal(sent.text, getCurrentSystemPrompt(received[0] ?? []))
    assert.deepEqual(
      sent.sections.map((section) => section.id),
      ids
    )
    assert.equal(sent.text, preview.text)

    // A changed section is sent again as an update; the list shows it.
    await conversation.configure({ instructions: "Be very kind." }, ctx)
    await (
      await conversation.submit({ type: "input", content: "again" }, ctx)
    ).wait(ctx)
    const updated = await promptOf()
    assert.equal(updated.updates, 1)
    assert.equal(
      updated.sections.at(-1)?.text,
      "<instructions>\nBe very kind.\n</instructions>"
    )
    assert.equal(updated.text, getCurrentSystemPrompt(received[1] ?? []))
  } finally {
    await harness.close(ctx)
  }
})

void test("GET /api/agent/system-prompt returns the sections and one section", async () => {
  const { dir, project, agentDir } = await folders()
  const data = join(dir, "data")
  await mkdir(data, { recursive: true })
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(data, "smith.sqlite")),
    {
      models: (await import("@earendil-works/pi-ai")).createModels(),
      registry: createRegistry(),
    },
    ctx
  )
  let id = ""
  try {
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { cwd: project },
        init: async (tx, conversationId) => {
          Object.assign(await tx.doc(AgentMetaDoc, conversationId), {
            cwd: project,
            name: "Prompt",
            createdAt: Date.now(),
            modifiedAt: Date.now(),
            firstMessage: "Prompt",
            messageCount: 0,
          })
        },
      },
      ctx
    )
    id = publicId(conversation.id)
  } finally {
    await harness.close(ctx)
  }
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
    {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  let log = ""
  child.stdout.on("data", (chunk) => {
    log += chunk.toString()
  })
  child.stderr.on("data", (chunk) => {
    log += chunk.toString()
  })
  const exited = new Promise<void>((done) => child.once("exit", () => done()))
  try {
    let port: number | undefined
    for (let i = 0; i < 150; i++) {
      try {
        port = JSON.parse(
          await readFile(join(data, "server.json"), "utf8")
        ).port
        break
      } catch {
        /* Wait for startup. */
      }
      if (child.exitCode !== null) throw new Error(log)
      await new Promise((done) => setTimeout(done, 100))
    }
    assert.ok(port, log)
    const url = `http://127.0.0.1:${port}/api/agent/system-prompt?agent=${id}`
    const response = await fetch(url)
    assert.equal(response.status, 200, log)
    const prompt = (await response.json()) as {
      sent: boolean
      cwd: string
      text: string
      sections: Array<{
        id: string
        extension?: string
        title: string
        text: string
        tagged: boolean
        files?: Array<{ path: string; scope: string }>
      }>
    }
    assert.equal(prompt.sent, false)
    assert.equal(prompt.cwd, project)
    const ids = prompt.sections.map((section) => section.id)
    assert.equal(ids[0], "preamble")
    assert.ok(ids.indexOf("rules") < ids.indexOf("project_context"))
    assert.ok(ids.indexOf("project_context") < ids.indexOf("cwd"))
    // The sections of other extensions come after the smith extension's.
    assert.ok(
      prompt.sections
        .slice(ids.indexOf("cwd") + 1)
        .every((section) => section.extension !== "smith")
    )
    const context = prompt.sections.find(
      (section) => section.id === "project_context"
    )
    assert.equal(context?.title, "Project context")
    assert.deepEqual(
      context?.files?.map((file) => file.scope),
      ["global", "project"]
    )
    assert.ok(prompt.text.includes("Project rule: say hi."))
    assert.equal(
      prompt.text,
      prompt.sections.map((section) => section.text).join("\n\n")
    )
    const one = (await (await fetch(`${url}&section=cwd`)).json()) as {
      text: string
    }
    assert.equal(one.text, `<cwd>\n${project}\n</cwd>`)
    assert.equal((await fetch(`${url}&section=nothing`)).status, 404)
  } finally {
    child.kill("SIGTERM")
    await exited
  }
})
