/** Copies text, with a fallback for pages where the clipboard API is denied. */
export async function copyTextToClipboard(text: string) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall through to the textarea fallback below. The async clipboard API
      // can be denied even on secure origins.
    }
  }

  if (copyTextWithTextarea(text)) {
    return
  }

  throw new Error("Unable to copy text")
}

function copyTextWithTextarea(text: string) {
  const activeElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  const selection = document.getSelection()
  const ranges: Range[] = []

  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      ranges.push(selection.getRangeAt(index).cloneRange())
    }
  }

  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.readOnly = true
  textarea.setAttribute("aria-hidden", "true")
  Object.assign(textarea.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    padding: "0",
    border: "0",
    opacity: "0",
    pointerEvents: "none",
  })

  document.body.append(textarea)
  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  let copied = false
  try {
    copied = document.execCommand("copy")
  } finally {
    textarea.remove()

    if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) {
        selection.addRange(range)
      }
    }

    activeElement?.focus({ preventScroll: true })
  }

  return copied
}
