import * as React from "react"

import {
  clearLoader,
  mountLoaderElement,
  setLoaderActive,
} from "@/components/ui/dna-loader.js"
import { cn } from "@/lib/utils"

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
  const ref = React.useRef<HTMLSpanElement>(null)
  React.useEffect(() => {
    const element = ref.current
    if (!element) return
    mountLoaderElement(element)
    return () => clearLoader(element)
  }, [])
  React.useEffect(() => {
    setLoaderActive(ref.current, active)
  }, [active])
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center [contain:layout_paint] [&>canvas]:block [&>canvas]:size-full",
        className
      )}
    />
  )
}
