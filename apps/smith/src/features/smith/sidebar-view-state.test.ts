import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test"

import {
  collapsedProjectStoreFor,
  groupRenderCount,
  groupStatusFilter,
  legacyCollapsedProjectsKey,
  migrateLegacyCollapsedProjects,
  nextRenderCount,
  resetSidebarViewStateForTests,
  sameCollapsedProjectState,
  setProjectsCollapsed,
  toggleGroupStatusFilter,
} from "@/features/smith/sidebar-view-state"
import { INITIAL_PROJECT_AGENT_RENDER_COUNT } from "@/lib/smith"

/** A small window with local storage and events, for the stores. */
function installFakeWindow() {
  const items = new Map<string, string>()
  const target = new EventTarget()
  const fake = {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  }
  Object.assign(globalThis, { window: fake })
  return { items, target }
}

let fake: ReturnType<typeof installFakeWindow>

beforeEach(() => {
  fake = installFakeWindow()
  resetSidebarViewStateForTests()
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window")
})

describe("collapsed projects", () => {
  test("setProjectsCollapsed keeps the object when nothing changes", () => {
    const state = { "/a": true }
    expect(setProjectsCollapsed(state, ["/a"], true)).toBe(state)
    expect(setProjectsCollapsed(state, ["/b"], false)).toBe(state)
    expect(setProjectsCollapsed(state, ["/a", "/b"], true)).toEqual({
      "/a": true,
      "/b": true,
    })
    expect(setProjectsCollapsed(state, ["/a"], false)).toEqual({})
  })

  test("sameCollapsedProjectState ignores open entries", () => {
    expect(
      sameCollapsedProjectState({ "/a": true, "/b": false }, { "/a": true })
    ).toBe(true)
    expect(sameCollapsedProjectState({ "/a": true }, { "/b": true })).toBe(
      false
    )
  })

  test("the live rows and the summary rows of a machine share one store", () => {
    const live = collapsedProjectStoreFor("m1")
    const summary = collapsedProjectStoreFor("m1")
    expect(summary).toBe(live)
    expect(collapsedProjectStoreFor("m2")).not.toBe(live)

    summary.setCollapsed("/a", true)
    expect(live.state).toEqual({ "/a": true })
    // The key that the sidebar sync sends to the machine's server.
    expect(fake.items.get("smith-collapsed-directories@m1")).toBe(
      JSON.stringify({ "/a": true })
    )
  })

  test("a store reads the shared key when it starts", () => {
    fake.items.set(
      "smith-collapsed-directories@m1",
      JSON.stringify({ "/x": true })
    )
    expect(collapsedProjectStoreFor("m1").state).toEqual({ "/x": true })
  })

  test("a change from another device reloads the store", () => {
    const store = collapsedProjectStoreFor("m1")
    fake.items.set(
      "smith-collapsed-directories@m1",
      JSON.stringify({ "/y": true })
    )
    window.dispatchEvent(
      new CustomEvent("smith:sidebar-state", {
        detail: { machineId: "m1", changed: ["collapsedProjects"] },
      })
    )
    expect(store.state).toEqual({ "/y": true })
  })

  test("the old window key moves to the shared key when it is missing", () => {
    fake.items.set(legacyCollapsedProjectsKey("m1"), '{"/old":true}')
    expect(collapsedProjectStoreFor("m1").state).toEqual({ "/old": true })
    expect(fake.items.get("smith-collapsed-directories@m1")).toBe(
      '{"/old":true}'
    )
    expect(fake.items.has(legacyCollapsedProjectsKey("m1"))).toBe(false)
  })

  test("the shared key wins over the old window key", () => {
    fake.items.set(legacyCollapsedProjectsKey("m1"), '{"/old":true}')
    fake.items.set("smith-collapsed-directories@m1", '{"/new":true}')
    migrateLegacyCollapsedProjects("m1")
    expect(fake.items.get("smith-collapsed-directories@m1")).toBe(
      '{"/new":true}'
    )
    expect(fake.items.has(legacyCollapsedProjectsKey("m1"))).toBe(false)
  })
})

describe("group view state", () => {
  test("nextRenderCount adds agents up to the total, and less resets", () => {
    const start = INITIAL_PROJECT_AGENT_RENDER_COUNT
    expect(nextRenderCount(start, 100)).toBeGreaterThan(start)
    expect(nextRenderCount(start, start + 1)).toBe(start + 1)
    expect(nextRenderCount(start + 6, 100, true)).toBe(start)
  })

  test("the state filter of a group is one value for each machine", () => {
    expect(groupStatusFilter("m1", "project:/a")).toBeNull()
    toggleGroupStatusFilter("m1", "project:/a", "working")
    expect(groupStatusFilter("m1", "project:/a")).toEqual(["working"])
    expect(groupStatusFilter("m2", "project:/a")).toBeNull()
    expect(groupStatusFilter("m1", "pinned")).toBeNull()
    toggleGroupStatusFilter("m1", "project:/a", "working")
    expect(groupStatusFilter("m1", "project:/a")).toBeNull()
  })

  test("a group starts with the first agents", () => {
    expect(groupRenderCount("m1", "status:idle")).toBe(
      INITIAL_PROJECT_AGENT_RENDER_COUNT
    )
  })
})
