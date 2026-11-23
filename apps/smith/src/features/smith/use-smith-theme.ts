import * as React from "react"
import { useTheme } from "next-themes"

import {
  APPLIED_THEME_STORAGE_KEY,
  THEME_COLOR_MODE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  appliedThemeClass,
  appliedThemeClassColorMode,
  normalizeThemeColorMode,
  normalizeThemeFamily,
  readStoredTheme,
  readStoredThemeColorMode,
  safeLocalStorageSetItem,
  themeFamilyFixedMode,
  type ThemeColorMode,
  type ThemeFamily,
} from "@/lib/smith"

type ThemeState = { themeFamily: ThemeFamily; colorMode: ThemeColorMode }

/**
 * The theme is window state: one store for the page, not one for each
 * machine's app shell. A shell that shows again after a machine switch
 * reads the same value, so it cannot put back an old theme. A change in
 * another tab comes in with the `storage` event.
 */
let themeSnapshot: ThemeState | undefined
const themeListeners = new Set<() => void>()

function readThemeState(): ThemeState {
  const themeFamily = readStoredTheme()
  return {
    themeFamily,
    colorMode: themeFamilyFixedMode(themeFamily) ?? readStoredThemeColorMode(),
  }
}

function getThemeSnapshot() {
  themeSnapshot ??= readThemeState()
  return themeSnapshot
}

function setThemeState(next: Partial<ThemeState>) {
  const current = getThemeSnapshot()
  const merged = { ...current, ...next }
  if (
    merged.themeFamily === current.themeFamily &&
    merged.colorMode === current.colorMode
  ) {
    return
  }
  themeSnapshot = merged
  for (const listener of themeListeners) listener()
}

function onStorage(event: StorageEvent) {
  if (
    event.key !== THEME_STORAGE_KEY &&
    event.key !== THEME_COLOR_MODE_STORAGE_KEY
  ) {
    return
  }
  setThemeState(readThemeState())
}

function subscribeTheme(listener: () => void) {
  if (themeListeners.size === 0) window.addEventListener("storage", onStorage)
  themeListeners.add(listener)
  return () => {
    themeListeners.delete(listener)
    if (themeListeners.size === 0) {
      window.removeEventListener("storage", onStorage)
    }
  }
}

export function useSmithTheme() {
  const { setTheme, systemTheme } = useTheme()
  const { themeFamily, colorMode } = React.useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getThemeSnapshot
  )
  const appliedTheme = appliedThemeClass(themeFamily, colorMode, systemTheme)

  React.useEffect(() => {
    setTheme(appliedTheme)
    safeLocalStorageSetItem(APPLIED_THEME_STORAGE_KEY, appliedTheme)

    const appliedThemeMode = appliedThemeClassColorMode(appliedTheme)
    if (appliedThemeMode) {
      document.documentElement.dataset.smithThemeMode = appliedThemeMode
    }
    // The iPhone status bar (and Safari's tab bar) take their color from
    // theme-color. Use the page background of the theme that now applies.
    const frame = window.requestAnimationFrame(syncThemeColorMeta)
    return () => window.cancelAnimationFrame(frame)
  }, [appliedTheme, setTheme])

  /** Shows a theme without saving it, for example while a picker is open. */
  const previewThemeFamily = (
    value: ThemeFamily,
    nextColorMode?: ThemeColorMode
  ) => {
    const nextTheme = normalizeThemeFamily(value)
    const fixedMode = themeFamilyFixedMode(nextTheme)
    setThemeState({
      themeFamily: nextTheme,
      ...(nextColorMode || fixedMode
        ? { colorMode: normalizeThemeColorMode(nextColorMode ?? fixedMode) }
        : {}),
    })
  }

  const setThemeFamily = (value: ThemeFamily) => {
    const nextTheme = normalizeThemeFamily(value)
    const fixedMode = themeFamilyFixedMode(nextTheme)
    safeLocalStorageSetItem(THEME_STORAGE_KEY, nextTheme)
    if (fixedMode) {
      safeLocalStorageSetItem(THEME_COLOR_MODE_STORAGE_KEY, fixedMode)
    }
    setThemeState({
      themeFamily: nextTheme,
      ...(fixedMode ? { colorMode: fixedMode } : {}),
    })
  }

  const setColorMode = (value: ThemeColorMode) => {
    const nextMode = normalizeThemeColorMode(value)
    safeLocalStorageSetItem(THEME_COLOR_MODE_STORAGE_KEY, nextMode)
    setThemeState({ colorMode: nextMode })
  }

  return {
    appliedTheme,
    colorMode,
    previewThemeFamily,
    setColorMode,
    setThemeFamily,
    systemTheme,
    themeFamily,
  }
}

/** Set `<meta name="theme-color">` to the page background, one tag only. */
function syncThemeColorMeta() {
  const color = toHexColor(getComputedStyle(document.body).backgroundColor)
  if (!color) return
  const tags = document.head.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]'
  )
  if (tags.length === 1 && tags[0].content === color && !tags[0].media) return
  // A new tag, not a new content: iOS WebKit repaints the status bar when the
  // tag is added, but only on the next touch when the content changes. The
  // tags of index.html follow the system scheme until the app runs.
  const tag = document.createElement("meta")
  tag.name = "theme-color"
  tag.content = color
  tags.forEach((old) => old.remove())
  document.head.appendChild(tag)
}

/**
 * A CSS color as `#rrggbb`. The themes use oklch(), and a plain hex color is
 * safe for every browser's theme-color.
 */
function toHexColor(color: string) {
  if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)")
    return undefined
  const canvas = document.createElement("canvas")
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext("2d")
  if (!context) return color
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`
}
