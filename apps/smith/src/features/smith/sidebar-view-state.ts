/**
 * The view state of the sidebar of each machine. The sidebar draws a
 * machine in two ways: the shell of the shown machine draws its live rows,
 * and the window draws the other machines from their hub summaries (see
 * `window-sidebar.tsx`). When the page shows another machine, one way
 * replaces the other. Both read the state here, one copy for each machine,
 * so a machine looks the same in both ways, and a change in one way stays
 * in the other.
 *
 * - The collapsed projects (and the Pinned group) are in local storage
 *   under the key that the sidebar sync sends to the machine's server
 *   (`sidebar-sync.ts`), so they are the same in all browsers.
 * - "Show N more" and the state filters of the project headings are page
 *   state, like the state filter of the machine heading
 *   (`agent-status-filter.ts`). They stay while the page is open.
 */
import * as React from "react"

import {
  toggleStatusFilter,
  type AgentStatusFilter,
  type AgentStatusFilters,
} from "@/features/smith/agent-status-filter"
import {
  createSmithStore,
  setStoreState,
  useSelector,
  type SmithStore,
} from "@/features/smith/tanstack-store-utils"
import {
  COLLAPSED_PROJECTS_STORAGE_KEY,
  INITIAL_PROJECT_AGENT_RENDER_COUNT,
  PROJECT_AGENT_LOAD_MORE_COUNT,
  machineLocalStorageGetItem,
  machineLocalStorageSetItem,
  readStoredCollapsedProjects,
} from "@/lib/smith"
import { storageKeyMachine } from "@/lib/smith/machine"

export type CollapsedProjectState = Record<string, boolean>

export type CollapsedProjectStore = SmithStore<CollapsedProjectState> & {
  loadStored: () => void
  toggle: (project: string) => void
  setCollapsed: (project: string, collapsed: boolean) => void
  setAll: (projects: Array<string>, collapsed: boolean) => void
  remove: (project: string) => void
}

export function sameCollapsedProjectState(
  left: CollapsedProjectState,
  right: CollapsedProjectState
) {
  const leftKeys = Object.keys(left).filter((key) => left[key])
  const rightKeys = Object.keys(right).filter((key) => right[key])
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => Boolean(right[key]))
}

/**
 * The state with each of `projects` collapsed or open. Returns `current`
 * when nothing changes. An open project has no entry.
 */
export function setProjectsCollapsed(
  current: CollapsedProjectState,
  projects: Array<string>,
  collapsed: boolean
): CollapsedProjectState {
  let next: CollapsedProjectState | undefined
  for (const project of projects) {
    if (Boolean((next ?? current)[project]) === collapsed) continue
    next ??= { ...current }
    if (collapsed) next[project] = true
    else delete next[project]
  }
  return next ?? current
}

/**
 * Before this store, the window kept the collapsed projects of a machine
 * that did not show under its own key, which the sidebar sync did not send.
 * Stored name: do not change.
 */
export function legacyCollapsedProjectsKey(machineId: string) {
  return `smith-machine-collapsed-directories:${machineId}`
}

/**
 * Move the old window copy of a machine's collapsed projects to the shared
 * key one time. The shared key wins: it is the copy that the shown machine
 * used and that the sidebar sync keeps.
 */
export function migrateLegacyCollapsedProjects(machineId: string) {
  const legacyKey = legacyCollapsedProjectsKey(machineId)
  let legacy: string | null
  try {
    legacy = window.localStorage.getItem(legacyKey)
  } catch {
    return
  }
  if (legacy === null) return
  if (
    machineLocalStorageGetItem(machineId, COLLAPSED_PROJECTS_STORAGE_KEY) ===
    null
  )
    machineLocalStorageSetItem(
      machineId,
      COLLAPSED_PROJECTS_STORAGE_KEY,
      legacy
    )
  try {
    window.localStorage.removeItem(legacyKey)
  } catch {
    // Ignore storage failures.
  }
}

export function createCollapsedProjectStore(
  machineId: string
): CollapsedProjectStore {
  const store = createSmithStore<CollapsedProjectState>(
    readStoredCollapsedProjects(machineId),
    sameCollapsedProjectState
  ) as CollapsedProjectStore

  const update = (
    action: (current: CollapsedProjectState) => CollapsedProjectState
  ) => {
    const before = store.state
    setStoreState(store, action)
    if (store.state === before) return
    machineLocalStorageSetItem(
      machineId,
      COLLAPSED_PROJECTS_STORAGE_KEY,
      JSON.stringify(store.state)
    )
  }

  Object.assign(store, {
    loadStored() {
      setStoreState(store, readStoredCollapsedProjects(machineId))
    },
    toggle(project) {
      store.setCollapsed(project, !store.state[project])
    },
    setCollapsed(project, collapsed) {
      update((current) => setProjectsCollapsed(current, [project], collapsed))
    },
    setAll(projects, collapsed) {
      update((current) => setProjectsCollapsed(current, projects, collapsed))
    },
    remove(project) {
      update((current) => setProjectsCollapsed(current, [project], false))
    },
  } satisfies Omit<
    CollapsedProjectStore,
    keyof SmithStore<CollapsedProjectState>
  >)

  return store
}

const collapsedStores = new Map<string, CollapsedProjectStore>()
let listening = false

function listenForStoredChanges() {
  if (listening || typeof window === "undefined") return
  listening = true
  // Another device changed the shared state (see `sidebar-sync.ts`).
  window.addEventListener("smith:sidebar-state", (event) => {
    const { machineId, changed } = (
      event as CustomEvent<{ machineId: string; changed: Array<string> }>
    ).detail
    if (changed.includes("collapsedProjects"))
      collapsedStores.get(machineId)?.loadStored()
  })
  // Another tab of this browser changed it.
  window.addEventListener("storage", (event) => {
    if (!event.key) return
    const scoped = storageKeyMachine(event.key)
    if (scoped?.key !== COLLAPSED_PROJECTS_STORAGE_KEY) return
    collapsedStores.get(scoped.machineId)?.loadStored()
  })
}

/**
 * The one collapsed-projects store of a machine, for its live rows and its
 * summary rows.
 */
export function collapsedProjectStoreFor(machineId: string) {
  let store = collapsedStores.get(machineId)
  if (!store) {
    if (typeof window !== "undefined") migrateLegacyCollapsedProjects(machineId)
    store = createCollapsedProjectStore(machineId)
    collapsedStores.set(machineId, store)
    listenForStoredChanges()
  }
  return store
}

/** Forget the stores, for tests. */
export function resetSidebarViewStateForTests() {
  collapsedStores.clear()
  listening = false
  setStoreState(groupViewStore, {})
}

/**
 * The page state of the agent groups of all machines. A group key is
 * `<machine>\0<group>`; see `groupViewKey`.
 */
type GroupViewState = {
  /** The agents that a group shows before "Show N more". */
  renderCount?: number
  /** The states that the counts in the group heading turned on. */
  statusFilter?: AgentStatusFilters
}

const groupViewStore = createSmithStore<Record<string, GroupViewState>>({})

/** A group: `project:<path>`, `pinned`, or `status:<state>`. */
export type SidebarGroupId = `project:${string}` | "pinned" | `status:${string}`

export function groupViewKey(machineId: string, group: SidebarGroupId) {
  return `${machineId}\0${group}`
}

function updateGroupView(
  key: string,
  action: (current: GroupViewState) => GroupViewState
) {
  setStoreState(groupViewStore, (state) => {
    const current = state[key] ?? {}
    const next = action(current)
    if (
      next.renderCount === current.renderCount &&
      next.statusFilter === current.statusFilter
    )
      return state
    return { ...state, [key]: next }
  })
}

/**
 * The next count of shown agents after a click on "Show N more" (or "Show
 * less", with `less`).
 */
export function nextRenderCount(current: number, total: number, less = false) {
  if (less) return INITIAL_PROJECT_AGENT_RENDER_COUNT
  return Math.max(
    INITIAL_PROJECT_AGENT_RENDER_COUNT,
    Math.min(total, current + PROJECT_AGENT_LOAD_MORE_COUNT)
  )
}

export function groupRenderCount(machineId: string, group: SidebarGroupId) {
  return (
    groupViewStore.state[groupViewKey(machineId, group)]?.renderCount ??
    INITIAL_PROJECT_AGENT_RENDER_COUNT
  )
}

/** "Show N more" of a group: how many agents it shows, and a setter. */
export function useGroupRenderCount(machineId: string, group: SidebarGroupId) {
  const key = groupViewKey(machineId, group)
  const renderCount = useSelector(
    groupViewStore,
    (state) => state[key]?.renderCount ?? INITIAL_PROJECT_AGENT_RENDER_COUNT
  )
  const setRenderCount = React.useCallback(
    (next: number) =>
      updateGroupView(key, (current) => ({
        ...current,
        renderCount:
          next === INITIAL_PROJECT_AGENT_RENDER_COUNT ? undefined : next,
      })),
    [key]
  )
  return [renderCount, setRenderCount] as const
}

export function groupStatusFilter(machineId: string, group: SidebarGroupId) {
  return (
    groupViewStore.state[groupViewKey(machineId, group)]?.statusFilter ?? null
  )
}

export function toggleGroupStatusFilter(
  machineId: string,
  group: SidebarGroupId,
  filter: AgentStatusFilter
) {
  updateGroupView(groupViewKey(machineId, group), (current) => {
    const next = toggleStatusFilter(current.statusFilter ?? null, filter)
    return { ...current, statusFilter: next ?? undefined }
  })
}

/** The state filter of a group heading, and its toggle. */
export function useGroupStatusFilter(machineId: string, group: SidebarGroupId) {
  const key = groupViewKey(machineId, group)
  const statusFilter = useSelector(
    groupViewStore,
    (state) => state[key]?.statusFilter ?? null
  )
  const toggle = React.useCallback(
    (filter: AgentStatusFilter) =>
      toggleGroupStatusFilter(machineId, group, filter),
    [machineId, group]
  )
  return [statusFilter, toggle] as const
}
