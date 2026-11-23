import assert from "node:assert/strict"
import { createServer } from "node:http"
import { Agent } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"

import { Router } from "../src/http.ts"
import { updateRequestFromArgs } from "../src/machines/cli.ts"
import { MachineError, type MachineInfo } from "../src/machines/manager.ts"
import { updateOverSsh } from "../src/machines/remote.ts"
import { addMachineUpdateRoute } from "../src/machines/routes.ts"
import type { ExecResult, MachineTransport } from "../src/machines/transport.ts"
import {
  MachineUpdater,
  parseUpdateRequest,
  planUpdates,
  updateMachine,
  type MachineUpdateStatus,
  type UpdatableMachine,
} from "../src/machines/update.ts"
import { isVersion } from "../src/services/self-update.ts"

function info(partial: Partial<MachineInfo> & { id: string }): MachineInfo {
  return {
    label: partial.id,
    target: partial.id,
    dataDir: null,
    enabled: true,
    state: "online",
    since: 0,
    ...partial,
  }
}

const MACHINES = [
  info({ id: "local", label: "hub", version: "3.2.0" }),
  info({ id: "m_old", label: "workbox", version: "3.1.0" }),
  info({ id: "m_same", label: "gpu", version: "3.2.0" }),
  info({ id: "m_new", label: "lab", version: "3.3.0" }),
  info({ id: "m_off", label: "nas", enabled: false, state: "disabled" }),
  info({ id: "m_unknown", label: "pi", state: "offline" }),
]

void test("the plan skips disabled, current, and newer machines", () => {
  const plan = planUpdates(MACHINES, { all: true }, "3.2.0")
  assert.deepEqual(
    plan.map((entry) => [entry.label, entry.action, entry.reason]),
    [
      ["workbox", "update", undefined],
      ["gpu", "skip", "already at 3.2.0"],
      ["lab", "skip", "at 3.3.0, newer than this hub (3.2.0)"],
      ["nas", "skip", "disabled"],
      ["pi", "update", undefined],
    ]
  )
  assert.equal(plan[0]!.target, "3.2.0")
  assert.equal(plan[0]!.from, "3.1.0")

  // An explicit version also goes back; only the same version skips.
  const pinned = planUpdates(
    MACHINES,
    { ids: ["lab", "GPU", "m_lab"].slice(0, 2), version: "3.2.0" },
    "3.2.0"
  )
  assert.deepEqual(
    pinned.map((entry) => [entry.label, entry.action]),
    [
      ["lab", "update"],
      ["gpu", "skip"],
    ]
  )

  // `latest` has no target: each machine finds its own.
  const latest = planUpdates(MACHINES, { ids: ["gpu"], latest: true }, "3.2.0")
  assert.equal(latest[0]!.action, "update")
  assert.equal(latest[0]!.target, undefined)

  // A machine that updates now is skipped.
  assert.equal(
    planUpdates(MACHINES, { ids: ["workbox"] }, "3.2.0", () => true)[0]!.reason,
    "already updating"
  )
  assert.throws(
    () => planUpdates(MACHINES, { ids: ["nope"] }, "3.2.0"),
    (error: unknown) => error instanceof MachineError && error.status === 404
  )
  assert.throws(
    () => planUpdates(MACHINES, { ids: ["local"] }, "3.2.0"),
    /smith update/
  )
})

void test("update requests and CLI arguments are checked", () => {
  assert.deepEqual(parseUpdateRequest({ all: true, version: "v3.1.0" }), {
    all: true,
    version: "3.1.0",
  })
  assert.deepEqual(parseUpdateRequest({ ids: ["a", 3, ""], latest: true }), {
    ids: ["a"],
    latest: true,
  })
  assert.throws(() => parseUpdateRequest({}), /ids/)
  assert.throws(() => parseUpdateRequest({ all: true, version: "x; rm" }))
  assert.throws(() =>
    parseUpdateRequest({ all: true, version: "3.1.0", latest: true })
  )

  assert.deepEqual(updateRequestFromArgs(["update", "workbox"]), {
    ids: ["workbox"],
  })
  assert.deepEqual(
    updateRequestFromArgs(["update", "--all", "--version", "3.2.0-beta.1"]),
    { all: true, version: "3.2.0-beta.1" }
  )
  assert.deepEqual(updateRequestFromArgs(["update", "gpu", "--latest"]), {
    ids: ["gpu"],
    latest: true,
  })
  assert.deepEqual(
    updateRequestFromArgs(["update", "--version=v3.1.0", "gpu"]),
    { ids: ["gpu"], version: "3.1.0" }
  )
  assert.throws(() => updateRequestFromArgs(["update"]), /--all/)
  assert.throws(() => updateRequestFromArgs(["update", "a", "--all"]))
  assert.throws(() => updateRequestFromArgs(["update", "a", "b"]))
  assert.throws(() => updateRequestFromArgs(["update", "a", "--version"]))
  assert.throws(() =>
    updateRequestFromArgs(["update", "a", "--latest", "--version", "3.1.0"])
  )
  assert.throws(() => updateRequestFromArgs(["update", "a", "--version", "x"]))

  assert.ok(isVersion("3.1.3"))
  assert.ok(isVersion("3.2.0-beta.1"))
  assert.ok(!isVersion("latest"))
  assert.ok(!isVersion("3.1.3 && rm"))
})

/**
 * A remote Smith behind a hub connection: its update routes, its restart,
 * and its SSH update, all in memory. `tick` runs at each sleep of the
 * updater, like time that passes.
 */
class FakeMachine implements UpdatableMachine {
  state: MachineInfo["state"] = "online"
  running: string
  installed: string
  features = ["machine-hub", "self-update", "self-update-version"]
  install: "npm" | "source" = "npm"
  latest = "3.3.0"
  /** Sleeps before an install ends, and before a restart ends. */
  installTicks = 2
  restartTicks = 2
  installError: string | undefined
  sshError: string | undefined
  calls: string[] = []
  #installing = 0
  #pendingInstall: string | undefined
  #restarting = 0
  constructor(version: string) {
    this.running = version
    this.installed = version
  }
  info(): MachineInfo {
    return info({
      id: "m_fake",
      label: "fake",
      state: this.state,
      version: this.running,
      features: this.features,
    })
  }
  tick() {
    if (this.#installing > 0 && --this.#installing === 0) {
      if (!this.installError) this.installed = this.#pendingInstall!
    }
    if (this.#restarting > 0 && --this.#restarting === 0) {
      this.running = this.installed
      this.state = "online"
    }
  }
  status() {
    return {
      ok: true,
      current: this.running,
      installed: this.installed,
      install: this.install,
      latest: this.latest,
      available: this.latest !== this.installed,
      installing: this.#installing > 0,
      ...(this.#installing === 0 && this.installError
        ? { error: this.installError }
        : {}),
    }
  }
  async request(
    method: string,
    path: string,
    options: { body?: unknown } = {}
  ) {
    this.calls.push(
      `${method} ${path}${options.body ? ` ${JSON.stringify(options.body)}` : ""}`
    )
    if (this.state !== "online") throw new MachineError(503, "fake is offline")
    if (path === "/api/system/update" || path === "/api/system/update/check")
      return this.status()
    if (path === "/api/system/update/install") {
      const body = (options.body ?? {}) as { version?: string }
      this.#pendingInstall = body.version ?? this.latest
      this.#installing = this.installTicks
      return this.status()
    }
    if (path === "/api/system/restart") {
      this.state = "offline"
      this.#restarting = this.restartTicks
      return { ok: true }
    }
    throw new MachineError(404, `Unknown route ${path}`)
  }
  retryNow() {
    this.calls.push("retry")
  }
  async sshUpdate(version: string | undefined) {
    this.calls.push(`ssh ${version ?? "latest"}`)
    if (this.sshError) throw new Error(this.sshError)
    this.installed = version ?? this.latest
    this.state = "offline"
    this.#restarting = this.restartTicks
    return {}
  }
}

function timingFor(machine: FakeMachine, reconnectMs = 10_000) {
  let now = 0
  return {
    installMs: 60_000,
    reconnectMs,
    pollMs: 1000,
    now: () => now,
    sleep: async (ms: number) => {
      now += ms
      machine.tick()
    },
  }
}

const plan = (target: string | undefined) => ({
  id: "m_fake",
  label: "fake",
  action: "update" as const,
  from: "3.1.0",
  ...(target ? { target } : {}),
})

void test("an online machine updates with its own route, then comes back", async () => {
  const machine = new FakeMachine("3.1.0")
  const steps: Array<string | undefined> = []
  const result = await updateMachine(machine, plan("3.2.0"), {
    timing: timingFor(machine),
    onChange: (status) => steps.push(status.step),
  })
  assert.equal(result.state, "done", result.message)
  assert.equal(result.version, "3.2.0")
  assert.equal(result.via, "route")
  assert.equal(result.step, undefined)
  assert.deepEqual(
    [...new Set(steps.filter(Boolean))],
    ["installing", "restarting", "reconnecting"]
  )
  assert.ok(
    machine.calls.includes(
      'POST /api/system/update/install {"version":"3.2.0"}'
    )
  )
  assert.ok(machine.calls.includes('POST /api/system/restart {"now":true}'))
  assert.ok(!machine.calls.some((call) => call.startsWith("ssh")))
})

void test("latest asks the machine; a machine at the newest version stays", async () => {
  const machine = new FakeMachine("3.1.0")
  const updated = await updateMachine(machine, plan(undefined), {
    timing: timingFor(machine),
  })
  assert.equal(updated.version, "3.3.0")
  assert.ok(machine.calls.includes("POST /api/system/update/check"))

  const current = new FakeMachine("3.3.0")
  const result = await updateMachine(current, plan(undefined), {
    timing: timingFor(current),
  })
  assert.equal(result.state, "done")
  assert.match(result.message ?? "", /already at 3.3.0/)
  assert.ok(!current.calls.some((call) => call.includes("install")))
})

void test("offline, old, or failing machines update over SSH", async () => {
  // Offline: SSH at once.
  const offline = new FakeMachine("3.1.0")
  offline.state = "offline"
  const first = await updateMachine(offline, plan("3.2.0"), {
    timing: timingFor(offline),
  })
  assert.equal(first.state, "done", first.message)
  assert.equal(first.via, "ssh")
  assert.equal(first.version, "3.2.0")
  assert.deepEqual(offline.calls.slice(0, 1), ["ssh 3.2.0"])

  // An old server that installs only its newest version: SSH.
  const old = new FakeMachine("3.1.0")
  old.features = ["machine-hub", "self-update"]
  const second = await updateMachine(old, plan("3.2.0"), {
    timing: timingFor(old),
  })
  assert.equal(second.via, "ssh")
  assert.ok(!old.calls.some((call) => call.includes("install")))

  // The same server installs its newest version itself.
  const oldLatest = new FakeMachine("3.1.0")
  oldLatest.features = ["machine-hub", "self-update"]
  const third = await updateMachine(oldLatest, plan("3.3.0"), {
    timing: timingFor(oldLatest),
  })
  assert.equal(third.via, "route")
  assert.ok(oldLatest.calls.includes("POST /api/system/update/install"))

  // npm fails in the route: SSH tries again.
  const failing = new FakeMachine("3.1.0")
  failing.installError = "npm failed"
  const fourth = await updateMachine(failing, plan("3.2.0"), {
    timing: timingFor(failing),
  })
  assert.equal(fourth.state, "done")
  assert.equal(fourth.via, "ssh")

  // Both fail: the error names both.
  const broken = new FakeMachine("3.1.0")
  broken.installError = "npm failed"
  broken.sshError = "ssh: connect to host fake: timed out"
  const fifth = await updateMachine(broken, plan("3.2.0"), {
    timing: timingFor(broken),
  })
  assert.equal(fifth.state, "failed")
  assert.match(fifth.message ?? "", /timed out.*npm failed/)

  // A source checkout cannot update with npm: no SSH try.
  const source = new FakeMachine("3.1.0")
  source.install = "source"
  const sixth = await updateMachine(source, plan("3.2.0"), {
    timing: timingFor(source),
  })
  assert.equal(sixth.state, "failed")
  assert.match(sixth.message ?? "", /source checkout/)
  assert.ok(!source.calls.some((call) => call.startsWith("ssh")))
})

void test("a machine that does not come back fails after the wait", async () => {
  const machine = new FakeMachine("3.1.0")
  machine.restartTicks = 1000
  const result = await updateMachine(machine, plan("3.2.0"), {
    timing: timingFor(machine, 5000),
  })
  assert.equal(result.state, "failed")
  assert.match(result.message ?? "", /not back with 3.2.0 after 5 s/)
  assert.ok(machine.calls.includes("retry"))
})

void test("the hub route starts the updates and the list shows them", async () => {
  const fake = new FakeMachine("3.1.0")
  const timing = timingFor(fake)
  let release = () => {}
  const gate = new Promise<void>((done) => {
    release = done
  })
  const machines = [
    info({ id: "local", label: "hub", version: "3.2.0" }),
    info({ id: "m_same", label: "gpu", version: "3.2.0" }),
    info({ id: "m_off", label: "nas", enabled: false, state: "disabled" }),
  ]
  const updater = new MachineUpdater(
    {
      list: () => [...machines, fake.info()],
      get: (id) => (id === "m_fake" ? fake : undefined),
    },
    {
      hubVersion: "3.2.0",
      timing: {
        ...timing,
        // Hold the update until the test has sent its second request.
        sleep: async (ms) => {
          await gate
          await timing.sleep(ms)
        },
      },
    }
  )
  const router = new Router()
  addMachineUpdateRoute(router, updater, () => ({
    machines: updater.withStatus([fake.info()]),
  }))
  const server = createServer((request, response) => {
    void router.handle(request, response)
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address() as AddressInfo
  const post = async (body: unknown) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/machines/update`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    )
    return {
      status: response.status,
      data: (await response.json()) as {
        plan?: Array<{ id: string; action: string; reason?: string }>
        machines?: Array<MachineInfo & { update?: MachineUpdateStatus }>
        hubVersion?: string
        error?: string
      },
    }
  }
  try {
    const changes: number[] = []
    const stop = updater.subscribe(() => changes.push(1))
    const started = await post({ all: true })
    assert.equal(started.status, 200)
    assert.equal(started.data.hubVersion, "3.2.0")
    assert.deepEqual(
      started.data.plan?.map((entry) => [entry.id, entry.action, entry.reason]),
      [
        ["m_same", "skip", "already at 3.2.0"],
        ["m_off", "skip", "disabled"],
        ["m_fake", "update", undefined],
      ]
    )
    assert.equal(started.data.machines?.[0]?.update?.state, "updating")
    // A second request while it runs skips the machine.
    const again = await post({ ids: ["fake"] })
    assert.equal(again.data.plan?.[0]?.reason, "already updating")
    release()

    for (
      let i = 0;
      i < 50 && updater.status("m_fake")?.state === "updating";
      i++
    )
      await new Promise((done) => setImmediate(done))
    assert.equal(updater.status("m_fake")?.state, "done")
    assert.equal(updater.status("m_fake")?.version, "3.2.0")
    assert.ok(changes.length > 2)
    stop()

    assert.equal((await post({ ids: ["nope"] })).status, 404)
    assert.equal((await post({})).status, 400)
    assert.equal((await post({ all: true, version: "nope" })).status, 400)
  } finally {
    server.close()
  }
})

class RecordingTransport implements MachineTransport {
  commands: string[][] = []
  answer: (argv: string[]) => ExecResult
  constructor(answer: (argv: string[]) => ExecResult) {
    this.answer = answer
  }
  async connect() {}
  async exec(argv: string[]) {
    this.commands.push(argv)
    return this.answer(argv)
  }
  async attach() {}
  endpoint() {
    return { host: "127.0.0.1", port: 9 }
  }
  agent() {
    return new Agent()
  }
  async close() {}
}

const CACHE = {
  nodeDir: "/n/bin",
  nodeVersion: "v22.19.0",
  smithPath: "/home/ali/.local/bin/smith",
  shellPath: "/usr/bin",
}
const STATUS = JSON.stringify({
  pid: 1,
  port: 3141,
  host: "127.0.0.1",
  version: "3.2.0",
})

void test("the SSH update runs smith update there, with its data directory", async () => {
  const transport = new RecordingTransport((argv) => {
    const command = argv.join(" ")
    if (command.includes("--help"))
      return { code: 0, stdout: "smith update [version]", stderr: "" }
    if (command.includes(" status --json"))
      return { code: 0, stdout: STATUS, stderr: "" }
    return { code: 0, stdout: "Smith 3.2.0 is installed.", stderr: "" }
  })
  const result = await updateOverSsh(
    transport,
    CACHE,
    { dataDir: "~/smith-data", label: "workbox" },
    "3.2.0"
  )
  assert.equal(result.upToDate, undefined)
  const update = transport.commands.find((argv) => argv.includes("update"))!
  assert.deepEqual(update.slice(-4), [
    "update",
    "3.2.0",
    "--data-dir",
    "~/smith-data",
  ])
  assert.ok(update[1]!.startsWith("PATH=/n/bin:/usr/bin"))
  // It runs: no start.
  assert.ok(!transport.commands.some((argv) => argv.includes("serve")))

  // A failing update names the output.
  const failing = new RecordingTransport((argv) =>
    argv.join(" ").includes("--help")
      ? { code: 0, stdout: "smith update", stderr: "" }
      : {
          code: 1,
          stdout: "Smith cannot update this install by itself. Run:\n  npm i",
          stderr: "",
        }
  )
  await assert.rejects(
    updateOverSsh(failing, CACHE, { dataDir: null, label: "w" }, "3.2.0"),
    /cannot update this install/
  )
})

void test("an old smith over SSH gets the install of machine add", async () => {
  let running = false
  const transport = new RecordingTransport((argv) => {
    const command = argv.join(" ")
    if (command.includes("--help"))
      return { code: 0, stdout: "smith serve", stderr: "" }
    if (command.includes(" status --json"))
      return running
        ? { code: 0, stdout: STATUS, stderr: "" }
        : { code: 1, stdout: "", stderr: "" }
    if (command.includes(" serve --detach")) running = true
    if (command.includes("sh -c") && command.includes("node="))
      return {
        code: 0,
        stdout:
          "path=/usr/bin\nnode=/n/bin v22.19.0\nsmith=/home/ali/.local/bin/smith\n",
        stderr: "",
      }
    return { code: 0, stdout: "", stderr: "" }
  })
  await updateOverSsh(transport, CACHE, { dataDir: null, label: "w" }, "3.2.0")
  const flat = transport.commands.map((argv) => argv.join(" "))
  assert.ok(flat.some((command) => command.includes("@alivault/smith@3.2.0")))
  // It did not run, so it starts.
  assert.ok(flat.some((command) => command.includes("serve --detach")))
  await assert.rejects(
    updateOverSsh(transport, CACHE, { dataDir: null, label: "w" }, undefined),
    /Give a version/
  )
})
