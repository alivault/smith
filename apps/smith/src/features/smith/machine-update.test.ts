import { describe, expect, test } from "vite-plus/test"

import {
  canUpdateMachine,
  compareVersions,
  endedUpdates,
  hubVersion,
  machinesToUpdate,
  type UpdatableMachineInfo,
} from "@/features/smith/machine-update"

const machine = (
  id: string,
  version?: string,
  extra: Partial<UpdatableMachineInfo> = {}
): UpdatableMachineInfo => ({
  id,
  enabled: true,
  ...(version ? { version } : {}),
  ...extra,
})

describe("machine updates", () => {
  test("versions sort like semver", () => {
    expect(compareVersions("3.1.3", "3.2.0")).toBeLessThan(0)
    expect(compareVersions("3.10.0", "3.9.9")).toBeGreaterThan(0)
    expect(compareVersions("3.2.0-beta.1", "3.2.0")).toBeLessThan(0)
    expect(compareVersions("3.2.0-beta.2", "3.2.0-beta.10")).toBeLessThan(0)
    expect(compareVersions("v3.2.0", "3.2.0")).toBe(0)
    expect(compareVersions("junk", "3.2.0")).toBeLessThan(0)
  })

  test("only remote, enabled machines behind the hub can update", () => {
    const machines = [
      machine("local", "3.2.0"),
      machine("old", "3.1.0"),
      machine("same", "3.2.0"),
      machine("newer", "3.3.0"),
      machine("off", "3.0.0", { enabled: false }),
      machine("unknown"),
      machine("too-old", undefined, { problem: { kind: "update" } }),
      machine("from-summary", undefined, { summary: { version: "3.0.0" } }),
      machine("busy", "3.0.0", { update: { state: "updating", startedAt: 1 } }),
    ]
    const hub = hubVersion(machines)
    expect(hub).toBe("3.2.0")
    expect(
      machines
        .filter((entry) => canUpdateMachine(entry, hub))
        .map((entry) => entry.id)
    ).toEqual(["old", "too-old", "from-summary", "busy"])
    expect(machinesToUpdate(machines).map((entry) => entry.id)).toEqual([
      "old",
      "too-old",
      "from-summary",
    ])
    expect(canUpdateMachine(machine("old", "1.0.0"), undefined)).toBe(false)
  })

  test("ended updates are the ones that this window started", () => {
    const machines = [
      machine("a", "2.0.0", { update: { state: "done", startedAt: 5 } }),
      machine("b", "1.0.0", { update: { state: "updating", startedAt: 5 } }),
      machine("c", "1.0.0", { update: { state: "failed", startedAt: 9 } }),
      machine("d", "1.0.0", { update: { state: "failed", startedAt: 5 } }),
      machine("e", "1.0.0"),
    ]
    const started = new Map([
      ["a", 5],
      ["b", 5],
      ["c", 5],
      ["e", 5],
    ])
    expect(endedUpdates(machines, started).map((entry) => entry.id)).toEqual([
      "a",
    ])
  })
})
