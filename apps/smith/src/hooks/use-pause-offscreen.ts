import * as React from "react"

/**
 * A ref that pauses the CSS animations of an element and its children (the
 * shimmer, a spinner) while the element is out of view. A shimmer moves a
 * background, so the browser computes the style and draws again in each
 * frame, also when nobody can see it: for example the running tool line of
 * a reply that grows below the bottom of the conversation. The element gets
 * `data-offscreen`; `styles.css` pauses the animations. Off when `active`
 * is false.
 */
export function usePauseOffscreen<T extends Element>(
  active: boolean,
  ref?: React.Ref<T>
): React.RefCallback<T> {
  return React.useCallback(
    (element: T | null) => {
      const cleanupRef = setRef(ref, element)
      if (!active || !element || typeof IntersectionObserver === "undefined")
        return cleanupRef
      const observer = new IntersectionObserver((entries) => {
        const entry = entries.at(-1)
        if (entry)
          element.toggleAttribute("data-offscreen", !entry.isIntersecting)
      })
      observer.observe(element)
      return () => {
        observer.disconnect()
        element.removeAttribute("data-offscreen")
        cleanupRef?.()
      }
    },
    [active, ref]
  )
}

/** Set a ref of the caller; returns its cleanup. */
function setRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") {
    const cleanup = ref(value)
    return typeof cleanup === "function"
      ? cleanup
      : () => {
          ref(null)
        }
  }
  if (ref) {
    ref.current = value
    return () => {
      ref.current = null
    }
  }
  return undefined
}
