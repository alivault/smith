import * as React from "react"
import mermaid from "mermaid"

let counter = 0

/** Whether the page shows the dark theme now; it follows theme changes. */
function useDarkTheme() {
  return React.useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange)
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      })
      return () => observer.disconnect()
    },
    () => document.documentElement.classList.contains("dark")
  )
}

/**
 * A Mermaid diagram, drawn to SVG on the client in the page's theme. When
 * Mermaid cannot read the source, `onError` gets the message; without it,
 * the message shows here.
 */
export default function MermaidView({
  source,
  onError,
}: {
  source: string
  onError?: (message: string) => void
}) {
  const dark = useDarkTheme()
  const [svg, setSvg] = React.useState("")
  const [error, setError] = React.useState("")
  const onErrorRef = React.useRef(onError)
  onErrorRef.current = onError
  React.useEffect(() => {
    let cancelled = false
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      fontFamily: "inherit",
    })
    counter += 1
    mermaid
      .render(`smith-mermaid-${counter}`, source)
      .then((result) => {
        if (!cancelled) {
          setSvg(result.svg)
          setError("")
        }
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        const message =
          reason instanceof Error ? reason.message : String(reason)
        setError(message)
        onErrorRef.current?.(message)
      })
    return () => {
      cancelled = true
    }
  }, [source, dark])
  if (error)
    return onError ? null : (
      <pre className="text-xs whitespace-pre-wrap text-destructive">
        {error}
      </pre>
    )
  if (!svg) return <div className="min-h-16" aria-busy="true" />
  return (
    <div
      className="overflow-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // Mermaid output with securityLevel "strict" has no scripts.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
