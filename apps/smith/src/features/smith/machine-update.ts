/**
 * Updates of Smith on the machines of a hub (`POST /api/machines/update`,
 * `server/src/machines/update.ts`). The hub updates a machine to its own
 * version, so a machine is behind when its version is older than the hub's.
 */
import { LOCAL_MACHINE_ID } from "@/lib/smith/machine"

/** The fields of a machine that the update helpers read. */
export type UpdatableMachineInfo = {
  id: string
  enabled: boolean
  version?: string
  summary?: { version: string }
  problem?: { kind: string }
  update?: { state: "updating" | "done" | "failed"; startedAt: number }
}

type Parsed = { numbers: Array<number>; pre: Array<string> }

function parse(value: string): Parsed | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(
    value.trim()
  )
  if (!match) return undefined
  return {
    numbers: match.slice(1, 4).map(Number),
    pre: match[4] ? match[4].split(".") : [],
  }
}

/**
 * Semver order, like the server's `compareVersions`: negative when `left`
 * is older. A prerelease is older than its release. Versions that do not
 * parse sort first.
 */
export function compareVersions(left: string, right: string) {
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return a ? 1 : b ? -1 : 0
  for (let index = 0; index < 3; index += 1) {
    const diff = a.numbers[index]! - b.numbers[index]!
    if (diff) return Math.sign(diff)
  }
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index]
    const y = b.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumber = /^\d+$/.test(x)
    const yNumber = /^\d+$/.test(y)
    if (xNumber && yNumber) return Math.sign(Number(x) - Number(y))
    if (xNumber !== yNumber) return xNumber ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

export function machineVersion(machine: UpdatableMachineInfo) {
  return machine.version || machine.summary?.version || undefined
}

/** The version of the hub: the version of its own machine. */
export function hubVersion(machines: ReadonlyArray<UpdatableMachineInfo>) {
  const local = machines.find((machine) => machine.id === LOCAL_MACHINE_ID)
  return local ? machineVersion(local) : undefined
}

/**
 * Whether the hub can update the machine to its own version: a remote,
 * enabled machine that is older than the hub, or that is too old to
 * connect (its version can be unknown then).
 */
export function canUpdateMachine(
  machine: UpdatableMachineInfo,
  hub: string | undefined
) {
  if (machine.id === LOCAL_MACHINE_ID || !machine.enabled || !hub) return false
  if (machine.problem?.kind === "update") return true
  const version = machineVersion(machine)
  return version !== undefined && compareVersions(version, hub) < 0
}

/** The machines that "Update all" updates: behind, and not updating now. */
export function machinesToUpdate<T extends UpdatableMachineInfo>(
  machines: ReadonlyArray<T>
) {
  const hub = hubVersion(machines)
  return machines.filter(
    (machine) =>
      canUpdateMachine(machine, hub) && machine.update?.state !== "updating"
  )
}

/**
 * The updates that ended, of the ones in `started` (machine ID → the
 * `startedAt` of its update). An update that a later one replaced does
 * not count.
 */
export function endedUpdates<T extends UpdatableMachineInfo>(
  machines: ReadonlyArray<T>,
  started: ReadonlyMap<string, number>
) {
  return machines.filter(
    (machine) =>
      machine.update !== undefined &&
      machine.update.state !== "updating" &&
      started.get(machine.id) === machine.update.startedAt
  )
}
