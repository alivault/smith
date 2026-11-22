import * as React from "react"

import { useMessageScroller } from "@/components/ui/message-scroller"

// Scroll behavior comes from the shadcn MessageScroller primitive. This module
// adds the Smith extras on top of it: jumps to the previous or next user message and extra
// "the reader is busy here" signals that stop follow-output.

export type MessageJumpStateSnapshot = {
  hasPreviousMessageJumpTarget: boolean
  hasNextMessageJumpTarget: boolean
}

export type MessageJumpStateStore = {
  getSnapshot: () => MessageJumpStateSnapshot
  subscribe: (listener: () => void) => () => void
}

const JUMP_OFFSET_PX = 8

function createMessageJumpStateStore() {
  let snapshot: MessageJumpStateSnapshot = {
    hasPreviousMessageJumpTarget: false,
    hasNextMessageJumpTarget: false,
  }
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => snapshot,
    setSnapshot: (nextSnapshot: MessageJumpStateSnapshot) => {
      if (
        snapshot.hasPreviousMessageJumpTarget ===
          nextSnapshot.hasPreviousMessageJumpTarget &&
        snapshot.hasNextMessageJumpTarget ===
          nextSnapshot.hasNextMessageJumpTarget
      ) {
        return
      }
      snapshot = nextSnapshot
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export function useMessageJumpValue<T>(
  store: MessageJumpStateStore,
  selector: (snapshot: MessageJumpStateSnapshot) => T
) {
  return React.useSyncExternalStore(
    store.subscribe,
    () => selector(store.getSnapshot()),
    () => selector(store.getSnapshot())
  )
}

function anchorScrollTop(anchor: HTMLElement, viewport: HTMLElement) {
  return (
    anchor.getBoundingClientRect().top -
    viewport.getBoundingClientRect().top +
    viewport.scrollTop
  )
}

function messageAnchorTops(viewport: HTMLElement) {
  return [
    ...viewport.querySelectorAll<HTMLElement>(
      "[data-user-message-anchor='true']"
    ),
  ].map((anchor) => anchorScrollTop(anchor, viewport))
}

function previousMessageJumpTop(viewport: HTMLElement) {
  const viewportTop = viewport.scrollTop + JUMP_OFFSET_PX - 1
  let target: number | null = null
  for (const top of messageAnchorTops(viewport)) {
    if (top >= viewportTop) break
    target = top
  }
  return target
}

function nextMessageJumpTop(viewport: HTMLElement) {
  const viewportTop = viewport.scrollTop + JUMP_OFFSET_PX + 1
  const maxScrollTop = viewport.scrollHeight - viewport.clientHeight
  if (viewport.scrollTop >= maxScrollTop - 1) return null
  for (const top of messageAnchorTops(viewport)) {
    if (top > viewportTop) return top
  }
  return null
}

// The primitive stops follow-output on wheel, touch, and scroll keys. A
// synthetic wheel event reuses that path for other reader signals.
/** How long after a jump the rest of a trackpad fling is dropped. */
const MOMENTUM_GUARD_MS = 900

/**
 * Stop the scroll momentum of a fling, so a jump lands where it should. A
 * smooth scroll stops it as a side effect; an instant jump does not:
 * - Touch (WebKit): momentum ends when the scroller stops being one for a
 *   moment.
 * - Trackpad: the system sends the rest of the fling as wheel events with
 *   falling deltas. Drop them for a short time, until a delta grows again,
 *   which is a new gesture of the reader.
 */
function stopMomentum(viewport: HTMLElement) {
  const overflow = viewport.style.overflowY
  viewport.style.overflowY = "hidden"
  void viewport.offsetHeight
  viewport.style.overflowY = overflow

  const until = performance.now() + MOMENTUM_GUARD_MS
  let last = Number.POSITIVE_INFINITY
  const onWheel = (event: WheelEvent) => {
    if (!event.isTrusted) return
    const delta = Math.abs(event.deltaY)
    if (performance.now() > until || delta > last * 1.5 + 1) {
      viewport.removeEventListener("wheel", onWheel, { capture: true })
      return
    }
    last = delta
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  viewport.addEventListener("wheel", onWheel, {
    capture: true,
    passive: false,
  })
  window.setTimeout(
    () => viewport.removeEventListener("wheel", onWheel, { capture: true }),
    MOMENTUM_GUARD_MS
  )
}

function releaseFollowOutput(viewport: HTMLElement) {
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true }))
}

function isOpeningToolCollapsibleTrigger(
  target: EventTarget | null,
  viewport: HTMLElement
) {
  if (!(target instanceof Element)) return false
  const trigger = target.closest<HTMLElement>(
    "[data-conversation-tool-collapsible-trigger='true']"
  )
  if (!trigger || !viewport.contains(trigger)) return false
  return trigger.getAttribute("aria-expanded") !== "true"
}

export function useAppShellMessageScroll() {
  const { scrollToEnd, scrollToStart } = useMessageScroller()
  const [viewport, setViewport] = React.useState<HTMLDivElement | null>(null)
  const [jumpStateStore] = React.useState(createMessageJumpStateStore)

  React.useEffect(() => {
    if (!viewport) return

    let frame = 0
    const syncJumpState = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        if (!viewport.isConnected) return
        jumpStateStore.setSnapshot({
          hasPreviousMessageJumpTarget:
            previousMessageJumpTop(viewport) !== null,
          hasNextMessageJumpTarget: nextMessageJumpTop(viewport) !== null,
        })
      })
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (isOpeningToolCollapsibleTrigger(event.target, viewport)) {
        releaseFollowOutput(viewport)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.key === "Enter" || event.key === " ") &&
        isOpeningToolCollapsibleTrigger(event.target, viewport)
      ) {
        releaseFollowOutput(viewport)
      }
    }

    const handleSelectionChange = () => {
      const selection = document.getSelection()
      if (!selection || selection.isCollapsed) return
      if (viewport.contains(selection.anchorNode)) {
        releaseFollowOutput(viewport)
      }
    }

    syncJumpState()
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(syncJumpState)
    resizeObserver?.observe(viewport)
    if (viewport.firstElementChild) {
      resizeObserver?.observe(viewport.firstElementChild)
    }
    viewport.addEventListener("scroll", syncJumpState, { passive: true })
    viewport.addEventListener("pointerdown", handlePointerDown, {
      capture: true,
      passive: true,
    })
    viewport.addEventListener("keydown", handleKeyDown, { capture: true })
    document.addEventListener("selectionchange", handleSelectionChange)

    return () => {
      window.cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      viewport.removeEventListener("scroll", syncJumpState)
      viewport.removeEventListener("pointerdown", handlePointerDown, {
        capture: true,
      })
      viewport.removeEventListener("keydown", handleKeyDown, { capture: true })
      document.removeEventListener("selectionchange", handleSelectionChange)
    }
  }, [jumpStateStore, viewport])

  const jumpTo = (getTop: (viewport: HTMLElement) => number | null) => {
    if (!viewport) return
    const top = getTop(viewport)
    if (top === null) return
    releaseFollowOutput(viewport)
    stopMomentum(viewport)
    viewport.scrollTo({
      top: Math.max(0, top - JUMP_OFFSET_PX),
      behavior: "auto",
    })
  }

  const jumpToPreviousMessage = () => jumpTo(previousMessageJumpTop)
  const jumpToNextMessage = () => jumpTo(nextMessageJumpTop)
  const scrollConversationToBottom = () => {
    if (viewport) stopMomentum(viewport)
    scrollToEnd({ behavior: "auto" })
  }
  const scrollConversationToTop = () => {
    if (viewport) stopMomentum(viewport)
    scrollToStart({ behavior: "auto" })
  }

  const stopScrollMomentum = () => {
    if (viewport) stopMomentum(viewport)
  }

  return {
    jumpStateStore: jumpStateStore as MessageJumpStateStore,
    jumpToNextMessage,
    jumpToPreviousMessage,
    scrollConversationToBottom,
    scrollConversationToTop,
    setViewport,
    stopScrollMomentum,
    viewport,
  }
}
