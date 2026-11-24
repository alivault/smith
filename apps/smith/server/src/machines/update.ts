/**
 * Update Smith on the machines of a hub: `smith machine update` and
 * `POST /api/machines/update`.
 *
 * For each machine, in parallel:
 * 1. An online machine with the `self-update` feature installs the version
 *    with its own update route (its own install location and channel), and
 *    restarts.
 * 2. Otherwise, or when the route fails, the hub runs `smith update` over
 *    SSH (`remote.ts`).
 * 3. The hub waits (up to two minutes) until the machine is online again,
 *    and reads its version.
 *
 * The default version is the hub's own, so that after a release and an
 * update of the hub, all machines run the same version. `latest` is the
 * newest version on each machine's channel.
 */
import { VERSION } from "../config.ts"
import {
  compareVersions,
  isVersion,
  PACKAGE_NAME,
} from "../services/self-update.ts"
import { MachineError, type MachineInfo } from "./manager.ts"
import { LOCAL_MACHINE_ID } from "./profiles.ts"

/** The remote server can update itself (`/api/system/update/*`). */
export const SELF_UPDATE_FEATURE = "self-update"
/** Its install route takes a `version`. */
export const SELF_UPDATE_VERSION_FEATURE = "self-update-version"

export type UpdateRequest = {
  /** Machine IDs or labels. */
  ids?: string[]
  all?: boolean
  /** The version to install; the hub's version by default. */
  version?: string
  /** The newest version on each machine's channel. */
  latest?: boolean
}

export type UpdateStep =
  | "publishing"
  | "installing"
  | "restarting"
  | "reconnecting"

/** The last update of a machine, in the hub's machine list. */
export type MachineUpdateStatus = {
  state: "updating" | "done" | "failed"
  step?: UpdateStep
  /** The version before the update, when known. */
  from?: string
  /** The version to install; unknown at first with `latest`. */
  target?: string
  /** The version that runs after the update. */
  version?: string
  via?: "route" | "ssh"
  /** What happened, or the error. */
  message?: string
  startedAt: number
  endedAt?: number
}

export type UpdatePlan = {
  id: string
  label: string
  action: "update" | "skip"
  /** Why the machine is skipped. */
  reason?: string
  from?: string
  target?: string
}

/** A machine that the updater can work on: a `MachineConnection`. */
export type UpdatableMachine = {
  info(): MachineInfo
  request(
    method: string,
    path: string,
    options?: { body?: unknown; timeoutMs?: number }
  ): Promise<unknown>
  retryNow(): void
  sshUpdate(version: string | undefined): Promise<{ upToDate?: string }>
}

/** The machines of a hub: a `MachineManager`. */
export type UpdateHost = {
  list(): MachineInfo[]
  get(id: string): UpdatableMachine | undefined
}

export type UpdateTiming = {
  /** How long npm may take on the machine. */
  installMs: number
  /** How long the machine may take to come back after the restart. */
  reconnectMs: number
  pollMs: number
  /** How long npm may take to serve the package file of a new release. */
  publishMs: number
  publishPollMs: number
  /**
   * Whether npm serves the package file of `version`: false while it does
   * not yet, undefined when the check itself failed.
   */
  published(version: string): Promise<boolean | undefined>
  now(): number
  sleep(ms: number): Promise<void>
}

/**
 * npm lists a new version some minutes before its package file can be
 * downloaded; an install in that time fails with a 404.
 */
async function npmPublished(version: string) {
  const name = PACKAGE_NAME.split("/").at(-1)
  const url = `https://registry.npmjs.org/${PACKAGE_NAME}/-/${name}-${version}.tgz`
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(10_000),
    })
    if (response.ok) return true
    return response.status === 404 ? false : undefined
  } catch {
    return undefined
  }
}

const DEFAULT_TIMING: UpdateTiming = {
  installMs: 10 * 60_000,
  reconnectMs: 2 * 60_000,
  pollMs: 1000,
  publishMs: 15 * 60_000,
  publishPollMs: 20_000,
  published: npmPublished,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** The version of a machine, from its manifest or its summary. */
export function machineVersion(info: MachineInfo) {
  return info.version || info.summary?.version || undefined
}

/** `v3.1.3` → `3.1.3`; throws for anything that is not a version. */
export function normalizeVersion(value: string) {
  const version = value.trim().replace(/^v/, "")
  if (!isVersion(version))
    throw new MachineError(400, `Not a version: ${value}`)
  return version
}

/** The body of `POST /api/machines/update`. */
export function parseUpdateRequest(body: unknown): UpdateRequest {
  const value = isRecord(body) ? body : {}
  const ids = Array.isArray(value.ids)
    ? value.ids.filter((id): id is string => typeof id === "string" && !!id)
    : []
  const all = value.all === true
  const latest = value.latest === true
  if (!all && ids.length === 0)
    throw new MachineError(400, "Give machine ids, or all")
  if (value.version !== undefined && typeof value.version !== "string")
    throw new MachineError(400, "version must be a string")
  if (latest && value.version)
    throw new MachineError(400, "Give a version or latest, not both")
  return {
    ...(all ? { all } : { ids }),
    ...(value.version ? { version: normalizeVersion(value.version) } : {}),
    ...(latest ? { latest } : {}),
  }
}

/**
 * Which machines to update, and which to skip and why. Unknown machines
 * and the hub itself are errors.
 */
export function planUpdates(
  machines: MachineInfo[],
  request: UpdateRequest,
  hubVersion: string,
  busy: (id: string) => boolean = () => false
): UpdatePlan[] {
  const remote = machines.filter((machine) => machine.id !== LOCAL_MACHINE_ID)
  let selected: MachineInfo[]
  if (request.all) selected = remote
  else {
    selected = []
    for (const name of request.ids ?? []) {
      if (name === LOCAL_MACHINE_ID)
        throw new MachineError(
          400,
          "Update this hub with: smith update (in a terminal on the hub)"
        )
      const wanted = name.trim().toLowerCase()
      const machine =
        remote.find((entry) => entry.id === name) ??
        remote.find((entry) => entry.label.toLowerCase() === wanted)
      if (!machine) throw new MachineError(404, `Unknown machine: ${name}`)
      if (!selected.includes(machine)) selected.push(machine)
    }
  }
  const target = request.latest ? undefined : (request.version ?? hubVersion)
  return selected.map((machine): UpdatePlan => {
    const from = machineVersion(machine)
    const base = {
      id: machine.id,
      label: machine.label,
      ...(from ? { from } : {}),
    }
    if (!machine.enabled || machine.state === "disabled")
      return { ...base, action: "skip", reason: "disabled" }
    if (busy(machine.id))
      return { ...base, action: "skip", reason: "already updating" }
    if (target && from) {
      const order = compareVersions(from, target)
      if (order === 0)
        return { ...base, action: "skip", reason: `already at ${target}` }
      // Without a version, only machines behind the hub update.
      if (order > 0 && !request.version)
        return {
          ...base,
          action: "skip",
          reason: `at ${from}, newer than this hub (${target})`,
        }
    }
    return { ...base, action: "update", ...(target ? { target } : {}) }
  })
}

type RemoteUpdateStatus = {
  current?: string
  installed?: string
  install?: string
  latest?: string
  available?: boolean
  installing?: boolean
  error?: string
}

/** An error after which the SSH way cannot help either. */
class FinalError extends Error {}

type RouteResult =
  | { kind: "unsupported"; reason: string }
  | { kind: "current"; version: string }
  | { kind: "restarting"; target: string }

/** Install with the machine's own update route, and restart it. */
async function updateWithRoute(
  machine: UpdatableMachine,
  target: string | undefined,
  timing: UpdateTiming,
  step: (step: UpdateStep) => void
): Promise<RouteResult> {
  const info = machine.info()
  if (info.state !== "online")
    return { kind: "unsupported", reason: `${info.label} is ${info.state}` }
  const features = info.features ?? []
  if (!features.includes(SELF_UPDATE_FEATURE))
    return {
      kind: "unsupported",
      reason: `Smith on ${info.label} cannot update itself`,
    }
  const read = async (method: "GET" | "POST", path: string, body?: unknown) =>
    (await machine.request(method, path, {
      timeoutMs: 30_000,
      ...(body ? { body } : {}),
    })) as RemoteUpdateStatus
  let status = await read("GET", "/api/system/update")
  if (status.install && status.install !== "npm")
    throw new FinalError(
      status.install === "source"
        ? `Smith on ${info.label} runs from a source checkout. Update it there with git.`
        : `Smith on ${info.label} was not installed with npm, so it cannot update itself. Update it there.`
    )
  const pinned = features.includes(SELF_UPDATE_VERSION_FEATURE)
  let wanted = target
  if (!wanted || !pinned) {
    status = await read("POST", "/api/system/update/check")
    if (!status.latest)
      throw new Error(status.error ?? "The machine found no new version")
    if (!wanted) {
      if (compareVersions(status.latest, status.current ?? "") <= 0)
        return { kind: "current", version: status.current ?? status.latest }
      wanted = status.latest
    } else if (status.latest !== wanted)
      // An older server installs only the newest version of its channel.
      return {
        kind: "unsupported",
        reason: `Smith on ${info.label} can install only ${status.latest} by itself`,
      }
  }
  step("installing")
  await read(
    "POST",
    "/api/system/update/install",
    pinned && target ? { version: wanted } : undefined
  )
  const deadline = timing.now() + timing.installMs
  for (;;) {
    status = await read("GET", "/api/system/update")
    if (!status.installing) break
    if (timing.now() > deadline)
      throw new FinalError(`npm on ${info.label} did not finish in time`)
    await timing.sleep(timing.pollMs)
  }
  if (status.error) throw new Error(status.error)
  if (status.installed !== wanted)
    throw new Error(
      `${info.label} has ${status.installed ?? "an unknown version"} on disk, not ${wanted}`
    )
  step("restarting")
  await read("POST", "/api/system/restart", { now: true })
  return { kind: "restarting", target: wanted }
}

/**
 * Wait until the machine is online with the new version. Without a
 * target, until it was offline (the restart) and is online again.
 */
async function waitUntilBack(
  machine: UpdatableMachine,
  target: string | undefined,
  timing: UpdateTiming
) {
  const deadline = timing.now() + timing.reconnectMs
  let restarted = false
  for (;;) {
    const info = machine.info()
    const version = machineVersion(info)
    if (info.state !== "online") restarted = true
    if (info.state === "online" && (target ? version === target : restarted))
      return version
    if (timing.now() > deadline)
      throw new Error(
        `${info.label} is not back${target ? ` with ${target}` : ""} after ${Math.round(timing.reconnectMs / 1000)} s (it is ${info.state}${version ? ` with ${version}` : ""})`
      )
    if (info.state === "offline" || info.state === "attention")
      machine.retryNow()
    await timing.sleep(timing.pollMs)
  }
}

/** Update one machine. Never throws: the result has the error. */
export async function updateMachine(
  machine: UpdatableMachine,
  plan: UpdatePlan,
  options: {
    timing?: Partial<UpdateTiming>
    onChange?: (status: MachineUpdateStatus) => void
  } = {}
): Promise<MachineUpdateStatus> {
  const timing = { ...DEFAULT_TIMING, ...options.timing }
  let status: MachineUpdateStatus = {
    state: "updating",
    ...(plan.from ? { from: plan.from } : {}),
    ...(plan.target ? { target: plan.target } : {}),
    startedAt: timing.now(),
  }
  const change = (next: Partial<MachineUpdateStatus>) => {
    status = { ...status, ...next }
    options.onChange?.(status)
  }
  const finish = (next: Partial<MachineUpdateStatus>) => {
    const { step: _step, ...rest } = { ...status, ...next }
    status = { ...rest, endedAt: timing.now() }
    options.onChange?.(status)
    return status
  }
  const step = (next: UpdateStep) => change({ step: next })
  change({})
  let target = plan.target
  let routeError: string | undefined
  try {
    if (target) await waitUntilPublished(target, timing, step)
    let result: RouteResult
    try {
      result = await updateWithRoute(machine, target, timing, step)
    } catch (error) {
      if (error instanceof FinalError) throw error
      routeError = message(error)
      result = { kind: "unsupported", reason: routeError }
    }
    if (result.kind === "current")
      return finish({
        state: "done",
        version: result.version,
        message: `already at ${result.version}, the newest version`,
      })
    if (result.kind === "restarting") {
      target = result.target
      change({ via: "route", target })
    } else {
      change({ via: "ssh" })
      step("installing")
      const ssh = await machine.sshUpdate(target)
      if (ssh.upToDate)
        return finish({
          state: "done",
          version: ssh.upToDate,
          message: `already at ${ssh.upToDate}, the newest version`,
        })
    }
    step("reconnecting")
    const version = await waitUntilBack(machine, target, timing)
    return finish({
      state: "done",
      ...(version ? { version } : {}),
      message: version ? `updated to ${version}` : "updated",
    })
  } catch (error) {
    return finish({
      state: "failed",
      message: routeError
        ? `${message(error)} (the update route failed first: ${routeError})`
        : message(error),
    })
  }
}

/** Wait until npm serves the package file of `version`. */
async function waitUntilPublished(
  version: string,
  timing: UpdateTiming,
  step: (step: UpdateStep) => void
) {
  const deadline = timing.now() + timing.publishMs
  for (;;) {
    const published = await timing.published(version)
    // A failed check does not stop the update: the install tells.
    if (published !== false) return
    if (timing.now() >= deadline)
      throw new FinalError(
        `npm does not serve ${PACKAGE_NAME}@${version} yet; try again in a few minutes`
      )
    step("publishing")
    await timing.sleep(timing.publishPollMs)
  }
}

/**
 * The updates of a hub. It keeps the last update of each machine for the
 * machine list, and tells its listeners about each change.
 */
export class MachineUpdater {
  readonly #host: UpdateHost
  readonly #hubVersion: string
  readonly #timing: Partial<UpdateTiming>
  readonly #statuses = new Map<string, MachineUpdateStatus>()
  readonly #listeners = new Set<() => void>()

  constructor(
    host: UpdateHost,
    options: { hubVersion?: string; timing?: Partial<UpdateTiming> } = {}
  ) {
    this.#host = host
    this.#hubVersion = options.hubVersion ?? VERSION
    this.#timing = options.timing ?? {}
  }

  get hubVersion() {
    return this.#hubVersion
  }

  status(id: string) {
    return this.#statuses.get(id)
  }

  /** The machine list with the update of each machine. */
  withStatus(machines: MachineInfo[]) {
    return machines.map((machine) => {
      const update = this.#statuses.get(machine.id)
      return update ? { ...machine, update } : machine
    })
  }

  /**
   * Plan the updates and start them. The plan comes back at once; `done`
   * ends when all updates end.
   */
  start(request: UpdateRequest) {
    const plan = planUpdates(
      this.#host.list(),
      request,
      this.#hubVersion,
      (id) => this.#statuses.get(id)?.state === "updating"
    )
    const done = Promise.all(
      plan
        .filter((entry) => entry.action === "update")
        .map(async (entry) => {
          const machine = this.#host.get(entry.id)
          if (!machine) return
          const result = await updateMachine(machine, entry, {
            timing: this.#timing,
            onChange: (status) => {
              this.#statuses.set(entry.id, status)
              this.#emit()
            },
          })
          console.log(
            `[smith] machine update ${entry.label}: ${result.state}${result.message ? `, ${result.message}` : ""}`
          )
        })
    ).then(() => undefined)
    return { plan, done }
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #emit() {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch (error) {
        console.error("[smith] machine update listener failed:", error)
      }
    }
  }
}
