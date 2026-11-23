/**
 * `smith machine …`: add and manage the SSH machines of a hub.
 *
 *   machine add <target> [--label L] [--data-dir D] [--yes]
 *   machine list [--json]
 *   machine status [<id-or-label>] [--json]
 *   machine reconnect <id-or-label>
 *   machine rename <id-or-label> --label L
 *   machine enable|disable|remove <id-or-label>
 *   machine update [<id-or-label> | --all] [--version V | --latest]
 *
 * `add` and `reconnect` run in a terminal, so SSH can ask for a password or
 * a host-key approval. Only `add` installs Smith, and only after the user
 * says yes. A running hub reads `machines.json` again within one second.
 */
import { readFileSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { createInterface } from "node:readline/promises"

import { serverPaths, VERSION, type ServerPaths } from "../config.ts"
import { isLoopback } from "../security.ts"
import type { MachineInfo } from "./manager.ts"
import {
  findProfile,
  labelFromTarget,
  machineDir,
  newMachineId,
  readCache,
  readProfiles,
  validTarget,
  writeCache,
  writeProfiles,
  type MachineCache,
  type MachineProfile,
} from "./profiles.ts"
import {
  cacheFromDiscovery,
  discover,
  HUB_FEATURE,
  installRemote,
  MIN_API_CONTRACT_VERSION,
  MIN_NODE,
  remoteStatus,
  remoteSupportsHub,
  remoteVersion,
  restartRemote,
  startRemote,
  updateOverSsh,
} from "./remote.ts"
import { SshTransport } from "./ssh.ts"
import type { MachineTransport } from "./transport.ts"
import {
  MachineUpdater,
  normalizeVersion,
  planUpdates,
  type MachineUpdateStatus,
  type UpdatableMachine,
  type UpdateHost,
  type UpdatePlan,
  type UpdateRequest,
  type UpdateStep,
} from "./update.ts"

type Options = Map<string, string | boolean>

const USAGE = `Usage:
  smith machine add <target> [--label L] [--data-dir D] [--yes]
  smith machine list [--json]
  smith machine status [<id-or-label>] [--json]
  smith machine reconnect <id-or-label>
  smith machine rename <id-or-label> --label L
  smith machine enable|disable|remove <id-or-label>
  smith machine update [<id-or-label> | --all] [--version V | --latest]

<target> is what you give to ssh: a host alias, user@host, a Tailscale
MagicDNS name, or ssh://user@host:2222. Smith uses your SSH config, keys, and
agent. It does not store passwords or keys.
--data-dir is the Smith data directory on the remote machine (default ~/.smith).
Use --hub-dir for the data directory of this hub.

update installs Smith on a machine, or on all machines, and restarts it.
The default version is the version of this hub, so all machines match it;
--latest is the newest version on each machine's update channel. An online
machine updates itself; else the hub runs smith update there over SSH.
Disabled machines and machines at the version are skipped.`

function parse(argv: string[]) {
  const positional: string[] = []
  const options: Options = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const [key, inline] = arg.slice(2).split("=", 2) as [
      string,
      string | undefined,
    ]
    if (inline !== undefined) options.set(key, inline)
    else if (
      ["label", "data-dir", "hub-dir", "version"].includes(key) &&
      argv[index + 1] !== undefined
    )
      options.set(key, argv[++index]!)
    else options.set(key, true)
  }
  return { positional, options }
}

function stringOption(options: Options, key: string) {
  const value = options.get(key)
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * A request to the running hub, if any: its address from `server.json`.
 * Undefined when no hub answers.
 */
async function hubCall(
  paths: ServerPaths,
  method: string,
  path: string,
  options: { body?: unknown; timeoutMs?: number } = {}
): Promise<{ ok: boolean; data: Record<string, unknown> } | undefined> {
  let state: { host?: string; port?: number }
  try {
    state = JSON.parse(readFileSync(paths.stateFile, "utf8")) as typeof state
  } catch {
    return undefined
  }
  if (!state.port) return undefined
  const host =
    !state.host || ["0.0.0.0", "::"].includes(state.host)
      ? "127.0.0.1"
      : state.host
  try {
    const response = await fetch(
      `http://${host.includes(":") ? `[${host}]` : host}:${state.port}${path}`,
      {
        method,
        signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
        ...(options.body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(options.body),
            }),
      }
    )
    const data = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >
    return { ok: response.ok, data }
  } catch {
    return undefined
  }
}

/** The answer of the running hub, if any and if it is good. */
async function hubRequest(paths: ServerPaths, method: string, path: string) {
  const result = await hubCall(paths, method, path)
  return result?.ok ? result.data : undefined
}

/** A JSON GET to the remote server through a transport. */
function remoteJson(transport: MachineTransport, path: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const request = httpRequest(
      {
        ...transport.endpoint(),
        agent: transport.agent(),
        method: "GET",
        path,
        headers: { host: "127.0.0.1" },
        timeout: 15_000,
      },
      (response) => {
        let text = ""
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => {
          text += chunk
        })
        response.once("end", () => {
          try {
            resolve(JSON.parse(text) as Record<string, unknown>)
          } catch {
            reject(new Error(`${path} did not return JSON`))
          }
        })
      }
    )
    request.once("timeout", () =>
      request.destroy(new Error(`${path} did not answer in time`))
    )
    request.once("error", reject)
    request.end()
  })
}

async function ask(question: string) {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

function log(message: string) {
  console.log(message)
}

type SetupOptions = {
  install: boolean
  assumeYes: boolean
}

/**
 * Connect in the terminal, find node and smith, start Smith if it does
 * not run, and check its manifest. Install and update only for `add`.
 */
async function setup(
  profile: MachineProfile,
  paths: ServerPaths,
  options: SetupOptions
) {
  const transport = new SshTransport({
    profile,
    machinesDir: paths.machinesDir,
    interactive: true,
  })
  const dir = machineDir(paths.machinesDir, profile.id)
  const abort = new AbortController()
  const interrupt = () => abort.abort()
  process.once("SIGINT", interrupt)
  try {
    log(`Connecting to ${profile.target} with SSH…`)
    await transport.connect(abort.signal)
    log("Connected.")

    let cache: MachineCache = cacheFromDiscovery(
      await discover(transport, abort.signal),
      readCache(dir)
    )
    if (!cache.nodeDir)
      throw new Error(
        `Node.js ${MIN_NODE.join(".")} or later was not found on ${profile.label}. Install it, then try again.`
      )
    const nodeDir = cache.nodeDir
    log(`Node.js ${cache.nodeVersion} in ${nodeDir}`)

    const confirm = (question: string) =>
      options.assumeYes ? Promise.resolve(true) : ask(question)

    let installedVersion = cache.smithPath
      ? await remoteVersion(transport, cache)
      : undefined
    const tooOld =
      installedVersion !== undefined &&
      !(await remoteSupportsHub(transport, cache))
    if (!cache.smithPath || !installedVersion || tooOld) {
      if (!options.install)
        throw new Error(
          `${tooOld ? `smith ${installedVersion} is too old` : "smith was not found"} on ${profile.label}. Run: smith machine add ${profile.target}`
        )
      if (
        !(await confirm(
          `${tooOld ? `smith ${installedVersion} on ${profile.label} is too old. Install` : "Install"} @alivault/smith@${VERSION} on ${profile.label} with npm (into ~/.local)?`
        ))
      )
        throw new Error("Canceled. Smith is not installed.")
      log("Installing…")
      await installRemote(transport, nodeDir, VERSION)
      cache = cacheFromDiscovery(await discover(transport), cache)
      installedVersion = cache.smithPath
        ? await remoteVersion(transport, cache)
        : undefined
      if (!cache.smithPath || !installedVersion)
        throw new Error(
          `smith is still not found on ${profile.label}. Add ~/.local/bin to PATH there.`
        )
    }
    log(`smith ${installedVersion} at ${cache.smithPath}`)
    writeCache(dir, cache)

    let status = await remoteStatus(transport, cache, profile)
    if (!status) {
      log(`Starting Smith on ${profile.label}…`)
      await startRemote(transport, cache, profile)
      status = await remoteStatus(transport, cache, profile)
      if (!status) throw new Error(`Smith did not start on ${profile.label}.`)
    } else if (!isLoopback(status.host)) {
      log(
        `Warning: Smith on ${profile.label} listens on ${status.host}, not only on 127.0.0.1. The hub uses SSH; you can restart it with --host 127.0.0.1.`
      )
    }
    await transport.attach(status.port)
    let manifest = await remoteJson(transport, "/api/client/manifest")
    const compatible = (value: Record<string, unknown>) => {
      const features = (value.capabilities as { features?: unknown })?.features
      return (
        Number(value.apiContractVersion ?? 0) >= MIN_API_CONTRACT_VERSION &&
        Array.isArray(features) &&
        features.includes(HUB_FEATURE)
      )
    }
    if (!compatible(manifest)) {
      if (!options.install)
        throw new Error(
          `Smith ${versionOf(manifest) ?? "(unknown version)"} on ${profile.label} is too old for this hub. Update it, or run: smith machine add ${profile.target}`
        )
      if (
        !(await confirm(
          `Smith ${versionOf(manifest) ?? "(unknown version)"} on ${profile.label} is too old. Update it to ${VERSION} with npm and restart it? Agents continue after the restart.`
        ))
      )
        throw new Error("Canceled. Smith on the remote machine is not updated.")
      await installRemote(transport, nodeDir, VERSION)
      cache = cacheFromDiscovery(await discover(transport), cache)
      writeCache(dir, cache)
      await restartRemote(transport, cache, profile)
      status = await remoteStatus(transport, cache, profile)
      if (!status) throw new Error(`Smith did not start on ${profile.label}.`)
      await transport.attach(status.port)
      manifest = await remoteJson(transport, "/api/client/manifest")
      if (!compatible(manifest))
        throw new Error(`Smith on ${profile.label} is still not compatible.`)
    }
    writeCache(dir, {
      ...cache,
      port: status.port,
      version: versionOf(manifest) ?? status.version,
    })
    log(
      `Smith ${versionOf(manifest) ?? "(unknown version)"} runs on ${profile.label} (port ${status.port}).`
    )
  } finally {
    process.off("SIGINT", interrupt)
    // Keep the SSH master: the hub uses it without asking again.
    await transport.close()
  }
}

function versionOf(manifest: Record<string, unknown>) {
  return typeof manifest.version === "string" ? manifest.version : undefined
}

function printMachines(machines: MachineInfo[]) {
  if (machines.length === 0) {
    log("No machines. Add one with: smith machine add <ssh-target>")
    return
  }
  for (const machine of machines) {
    const problem = machine.problem ? ` — ${machine.problem.message}` : ""
    log(
      `${machine.id}  ${machine.label.padEnd(16)} ${machine.target.padEnd(28)} ${machine.state}${problem}`
    )
  }
}

/** The profiles, with live states from the hub when it runs. */
async function machineStates(paths: ServerPaths): Promise<MachineInfo[]> {
  const profiles = readProfiles(paths.machinesFile)
  const live = (await hubRequest(paths, "GET", "/api/machines")) as
    | { machines?: MachineInfo[] }
    | undefined
  return profiles.map((profile) => {
    const info = live?.machines?.find((machine) => machine.id === profile.id)
    if (info) {
      const { summary: _summary, ...rest } = info
      return rest
    }
    return {
      ...profile,
      state: profile.enabled ? "offline" : "disabled",
      since: 0,
      ...(profile.enabled
        ? {
            problem: {
              kind: "error" as const,
              message: "The hub is not running",
            },
          }
        : {}),
    }
  })
}

/** The request of `smith machine update …` (the words after `machine`). */
export function updateRequestFromArgs(argv: string[]): UpdateRequest {
  const { positional, options } = parse(argv)
  const names = positional.slice(1)
  const all = options.get("all") === true
  const latest = options.get("latest") === true
  const version = options.get("version")
  if (names.length > 1) throw new Error(USAGE)
  if (all && names.length) throw new Error("Give a machine or --all, not both.")
  if (!all && !names.length)
    throw new Error(
      "Give a machine, or --all.\n  smith machine update [<id-or-label> | --all] [--version V | --latest]"
    )
  if (version === true) throw new Error("--version needs a version.")
  if (latest && version !== undefined)
    throw new Error("Give --version or --latest, not both.")
  return {
    ...(all ? { all } : { ids: names }),
    ...(typeof version === "string"
      ? { version: normalizeVersion(version) }
      : {}),
    ...(latest ? { latest } : {}),
  }
}

function describeStep(step: UpdateStep) {
  return step === "installing"
    ? "installing…"
    : step === "restarting"
      ? "restarting…"
      : "waiting until it is back…"
}

/**
 * Print the plan, then each step and result, until all updates end.
 * Returns whether all updates worked.
 */
async function followUpdates(
  plan: UpdatePlan[],
  read: () => Promise<Map<string, MachineUpdateStatus> | undefined>
) {
  if (!plan.length) {
    log("No machines to update.")
    return true
  }
  const width = Math.max(...plan.map((entry) => entry.label.length))
  const say = (entry: UpdatePlan, text: string) =>
    log(`${entry.label.padEnd(width)}  ${text}`)
  for (const entry of plan)
    if (entry.action === "skip") say(entry, `skipped: ${entry.reason}`)
  const running = new Map(
    plan
      .filter((entry) => entry.action === "update")
      .map((entry) => {
        say(
          entry,
          `updating${entry.from ? ` from ${entry.from}` : ""}${entry.target ? ` to ${entry.target}` : " to the newest version"}…`
        )
        return [entry.id, { entry, step: undefined as UpdateStep | undefined }]
      })
  )
  let failed = false
  // The hub ends each update in about 15 minutes at most.
  const deadline = Date.now() + 20 * 60_000
  while (running.size) {
    if (Date.now() > deadline) {
      for (const { entry } of running.values())
        say(entry, "failed: no result in time")
      return false
    }
    await new Promise((done) => setTimeout(done, 1000))
    const statuses = await read()
    if (!statuses) continue
    for (const [id, item] of running) {
      const status = statuses.get(id)
      if (!status) continue
      if (status.state === "updating") {
        if (status.step && status.step !== item.step) {
          item.step = status.step
          say(item.entry, describeStep(status.step))
        }
        continue
      }
      running.delete(id)
      if (status.state === "failed") failed = true
      say(
        item.entry,
        status.state === "done"
          ? (status.message ?? "updated")
          : `failed: ${status.message ?? "unknown error"}`
      )
    }
  }
  return !failed
}

/** A machine for updates without a running hub: SSH only. */
class SshOnlyMachine implements UpdatableMachine {
  readonly #profile: MachineProfile
  readonly #paths: ServerPaths
  readonly transport: SshTransport
  #info: MachineInfo

  constructor(
    profile: MachineProfile,
    paths: ServerPaths,
    interactive: boolean
  ) {
    this.#profile = profile
    this.#paths = paths
    this.transport = new SshTransport({
      profile,
      machinesDir: paths.machinesDir,
      interactive,
    })
    this.#info = {
      ...profile,
      state: profile.enabled ? "offline" : "disabled",
      since: 0,
    }
  }

  get #dir() {
    return machineDir(this.#paths.machinesDir, this.#profile.id)
  }

  info() {
    return this.#info
  }

  /** Read the version that runs there now. */
  async probe() {
    if (!this.#profile.enabled) return
    try {
      const signal = AbortSignal.timeout(60_000)
      await this.transport.connect(signal)
      let cache = readCache(this.#dir)
      if (!cache.smithPath || !cache.nodeDir)
        cache = cacheFromDiscovery(
          await discover(this.transport, signal),
          cache
        )
      const status = await remoteStatus(
        this.transport,
        cache,
        this.#profile,
        signal
      )
      if (status) this.#info = { ...this.#info, version: status.version }
    } catch {
      // The update tells what is wrong.
    }
  }

  request(): Promise<unknown> {
    return Promise.reject(new Error("The hub is not running"))
  }

  retryNow() {}

  async sshUpdate(version: string | undefined) {
    const signal = AbortSignal.timeout(15 * 60_000)
    await this.transport.connect(signal)
    const result = await updateOverSsh(
      this.transport,
      readCache(this.#dir),
      this.#profile,
      version,
      signal
    )
    const status = await remoteStatus(
      this.transport,
      result.cache,
      this.#profile,
      signal
    )
    writeCache(this.#dir, {
      ...result.cache,
      ...(status ? { port: status.port, version: status.version } : {}),
    })
    if (status)
      this.#info = { ...this.#info, state: "online", version: status.version }
    return result
  }
}

/** `smith machine update`: through the running hub, or else over SSH. */
async function updateCommand(argv: string[], paths: ServerPaths) {
  const request = updateRequestFromArgs(argv)
  const started = await hubCall(paths, "POST", "/api/machines/update", {
    body: request,
    timeoutMs: 30_000,
  })
  if (started) {
    if (!started.ok)
      throw new Error(
        typeof started.data.error === "string"
          ? started.data.error
          : "The hub could not start the update. Restart the hub to load this version of Smith."
      )
    const plan = (started.data.plan ?? []) as UpdatePlan[]
    if (!request.version && !request.latest)
      log(`This hub runs Smith ${String(started.data.hubVersion)}.`)
    const ok = await followUpdates(plan, async () => {
      const live = await hubRequest(paths, "GET", "/api/machines")
      if (!live) return undefined
      const machines = (live.machines ?? []) as MachineInfo[]
      return new Map(
        machines.flatMap((machine) =>
          machine.update ? [[machine.id, machine.update] as const] : []
        )
      )
    })
    if (!ok) process.exitCode = 1
    return
  }
  // No hub runs: update over SSH from here.
  log("The hub is not running. Updating over SSH from here.")
  const profiles = readProfiles(paths.machinesFile)
  const byId = new Map(
    profiles.map((profile) => [
      profile.id,
      new SshOnlyMachine(profile, paths, false),
    ])
  )
  const host: UpdateHost = {
    list: () => [...byId.values()].map((machine) => machine.info()),
    get: (id) => byId.get(id),
  }
  // Plan first, so that unknown names fail before any SSH work.
  const updater = new MachineUpdater(host, {
    hubVersion: VERSION,
    timing: { reconnectMs: 0 },
  })
  const selected = planUpdates(host.list(), request, VERSION)
    .filter((entry) => entry.action === "update")
    .map((entry) => byId.get(entry.id)!)
  await Promise.all(selected.map((machine) => machine.probe()))
  if (!request.version && !request.latest) log(`This hub has Smith ${VERSION}.`)
  const { plan, done } = updater.start(request)
  const ok = await followUpdates(plan, async () => {
    const statuses = new Map<string, MachineUpdateStatus>()
    for (const entry of plan) {
      const status = updater.status(entry.id)
      if (status) statuses.set(entry.id, status)
    }
    return statuses
  })
  await done
  // Keep the SSH masters: a hub uses them without asking again.
  await Promise.all(
    [...byId.values()].map((machine) => machine.transport.close())
  )
  if (!ok) process.exitCode = 1
}

export async function machineCommand(argv: string[], hubDir: string) {
  const { positional, options } = parse(argv)
  const paths = serverPaths(stringOption(options, "hub-dir") ?? hubDir)
  const [sub, name] = positional
  const json = options.get("json") === true
  const profiles = () => readProfiles(paths.machinesFile)
  const requireProfile = () => {
    if (!name) throw new Error(USAGE)
    const profile = findProfile(profiles(), name)
    if (!profile) throw new Error(`Unknown machine: ${name}`)
    return profile
  }
  const edit = (change: (profile: MachineProfile) => void) => {
    const list = profiles()
    const profile = findProfile(list, name ?? "")
    if (!profile) throw new Error(`Unknown machine: ${name}`)
    change(profile)
    writeProfiles(paths.machinesFile, list)
    return profile
  }

  switch (sub) {
    case "add": {
      if (!name) throw new Error(USAGE)
      const target = validTarget(name)
      const list = profiles()
      const label = stringOption(options, "label") ?? labelFromTarget(target)
      if (findProfile(list, label))
        throw new Error(
          `A machine with the label ${label} exists. Use --label to choose another.`
        )
      const profile: MachineProfile = {
        id: newMachineId(list.map((entry) => entry.id)),
        label,
        target,
        dataDir: stringOption(options, "data-dir") ?? null,
        enabled: true,
      }
      await setup(profile, paths, {
        install: true,
        assumeYes: options.get("yes") === true,
      })
      // Read again: the file can have changed while setup ran.
      const latest = profiles()
      writeProfiles(paths.machinesFile, [...latest, profile])
      log(
        `Added ${profile.label} (${profile.id}). A running hub connects to it within one second.`
      )
      log(
        "Anyone who can open this hub can run commands on this machine. Keep the hub on localhost or your tailnet."
      )
      return
    }
    case "list":
    case "status": {
      const machines = await machineStates(paths)
      const selected =
        sub === "status" && name
          ? machines.filter(
              (machine) =>
                machine.id === name ||
                machine.label.toLowerCase() === name.toLowerCase()
            )
          : machines
      if (sub === "status" && name && selected.length === 0)
        throw new Error(`Unknown machine: ${name}`)
      if (json) {
        console.log(JSON.stringify(selected, null, 2))
        return
      }
      printMachines(selected)
      if (sub === "status")
        for (const machine of selected)
          if (machine.problem?.detail)
            log(`\n${machine.label}:\n${machine.problem.detail}`)
      return
    }
    case "reconnect": {
      const profile = requireProfile()
      await setup(profile, paths, { install: false, assumeYes: false })
      const retried = await hubRequest(
        paths,
        "POST",
        `/api/machines/${encodeURIComponent(profile.id)}/retry`
      )
      log(
        retried
          ? `The hub connects to ${profile.label} now.`
          : `${profile.label} is ready. Start the hub with: smith`
      )
      return
    }
    case "rename": {
      const label = stringOption(options, "label")
      if (!name || !label) throw new Error(USAGE)
      const other = findProfile(profiles(), label)
      if (other && other.id !== requireProfile().id)
        throw new Error(`A machine with the label ${label} exists.`)
      const profile = edit((entry) => {
        entry.label = label
      })
      log(`Renamed ${profile.id} to ${label}.`)
      return
    }
    case "enable":
    case "disable": {
      const profile = edit((entry) => {
        entry.enabled = sub === "enable"
      })
      log(`${sub === "enable" ? "Enabled" : "Disabled"} ${profile.label}.`)
      return
    }
    case "update":
      await updateCommand(argv, paths)
      return
    case "remove": {
      const profile = requireProfile()
      writeProfiles(
        paths.machinesFile,
        profiles().filter((entry) => entry.id !== profile.id)
      )
      log(
        `Removed ${profile.label}. Smith and its agents keep running on that machine.`
      )
      return
    }
    default:
      console.log(USAGE)
      if (sub && sub !== "help") process.exitCode = 2
  }
}
