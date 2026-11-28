import * as React from "react"

import {
  clearLoader,
  mountLoaderElement,
  setLoaderActive,
} from "@/components/ui/dna-loader.js"
import { cn } from "@/lib/utils"

/**
 * A loader that just unmounted. When a `DnaLoader` mounts again in the same
 * commit (the working row moves to the new last row of the conversation),
 * it takes this element over, so the strand keeps turning and does not
 * start its animation again.
 */
let parked: { element: HTMLSpanElement; timer: number } | null = null

function takeParked() {
  if (!parked) return null
  window.clearTimeout(parked.timer)
  const { element } = parked
  parked = null
  return element
}

function park(element: HTMLSpanElement) {
  // Only one loader waits: an older one ends now.
  const older = takeParked()
  if (older) clearLoader(older)
  element.remove()
  parked = {
    element,
    timer: window.setTimeout(() => {
      if (parked?.element !== element) return
      parked = null
      clearLoader(element)
    }, 0),
  }
}

/**
 * The DNA strand loader: a 3D strand that turns while `active`. It draws in
 * the text color of its element and respects reduced motion. Size it with a
 * class (the old working indicator used 86×20 px).
 */
export function DnaLoader({
  active = true,
  className,
}: {
  active?: boolean
  className?: string
}) {
  const hostRef = React.useRef<HTMLSpanElement>(null)
  const loaderRef = React.useRef<HTMLSpanElement | null>(null)

  React.useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    let element = takeParked()
    if (!element) {
      element = document.createElement("span")
      element.className = "flex size-full [&>canvas]:block [&>canvas]:size-full"
    }
    host.append(element)
    mountLoaderElement(element)
    loaderRef.current = element
    return () => {
      loaderRef.current = null
      park(element)
    }
  }, [])

  React.useLayoutEffect(() => {
    setLoaderActive(loaderRef.current, active)
  }, [active])

  return (
    <span
      ref={hostRef}
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center [contain:layout_paint]",
        className
      )}
    />
  )
}
