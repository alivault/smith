import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { CheckIcon, CopyIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { copyTextToClipboard } from "@/lib/clipboard"
import { cn } from "@/lib/utils"

/**
 * Code Block, from shadcn/ui
 * (https://ui.shadcn.com/docs/components/base/code-block): code, terminal
 * output, and diffs. Restyled for Smith: a muted box with a header bar for
 * code, and a smaller (`sm`) box for tool output. Smith highlights code on
 * the server, so the content takes highlighted children.
 */
const codeBlockVariants = cva(
  "group/code-block not-prose relative flex w-full min-w-0 flex-col overflow-hidden border text-foreground has-[>[data-slot=code-block-content]:focus-visible]:ring-3 has-[>[data-slot=code-block-content]:focus-visible]:ring-ring/50 data-[size=default]:rounded-xl data-[size=default]:bg-muted/40 data-[size=default]:text-[13px] data-[size=sm]:rounded-lg data-[size=sm]:bg-background/80 data-[size=sm]:text-xs",
  {
    variants: {
      variant: {
        default: "",
        destructive: "text-destructive",
        // No box: the parent draws it.
        ghost: "rounded-none! border-0 bg-transparent!",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function CodeBlock({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof codeBlockVariants> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="code-block"
      data-variant={variant}
      data-size={size}
      className={cn(codeBlockVariants({ variant }), className)}
      {...props}
    />
  )
}

function CodeBlockHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-header"
      className={cn(
        "flex min-w-0 shrink-0 items-center justify-between gap-3 border-b bg-background/80 px-3 py-2 text-xs text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CodeBlockTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-title"
      className={cn(
        "min-w-0 truncate font-medium [&_svg]:pointer-events-none [&_svg]:inline-block [&_svg]:align-middle [&_svg:not([class*='size-'])]:size-3.5 *:[svg]:me-1.5",
        className
      )}
      {...props}
    />
  )
}

/**
 * Buttons for the block. In the header they sit at its end. As a direct
 * child of the block they float in its top right corner and show on hover.
 */
function CodeBlockActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-actions"
      className={cn(
        "ms-auto flex shrink-0 items-center gap-1 [[data-slot=code-block]>&]:absolute [[data-slot=code-block]>&]:end-1.5 [[data-slot=code-block]>&]:top-1.5 [[data-slot=code-block]>&]:z-10 [[data-slot=code-block]>&]:opacity-0 [[data-slot=code-block]>&]:transition-opacity [[data-slot=code-block]>&]:group-focus-within/code-block:opacity-100 [[data-slot=code-block]>&]:group-hover/code-block:opacity-100 [[data-slot=code-block]>&]:pointer-coarse:opacity-100 [[data-slot=code-block]>&]:*:[button]:bg-background",
        className
      )}
      {...props}
    />
  )
}

/** Copies `value`. With `label`, it says Copy, Copied, or Retry. */
const CodeBlockCopyButton = React.memo(function CodeBlockCopyButton({
  className,
  label = false,
  value,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "value" | "onClick"> & {
  label?: boolean
  value: string
}) {
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "error">(
    "idle"
  )

  React.useEffect(() => {
    if (copyState === "idle") return
    const timeout = window.setTimeout(() => setCopyState("idle"), 1400)
    return () => window.clearTimeout(timeout)
  }, [copyState])

  const text =
    copyState === "copied" ? "Copied" : copyState === "error" ? "Retry" : "Copy"

  return (
    <>
      <Button
        data-slot="code-block-copy-button"
        data-copied={copyState === "copied" || undefined}
        variant="ghost"
        size={label ? "xs" : "icon-xs"}
        aria-label={label ? undefined : text}
        className={className}
        onClick={() => {
          copyTextToClipboard(value).then(
            () => setCopyState("copied"),
            () => setCopyState("error")
          )
        }}
        {...props}
      >
        {copyState === "copied" ? (
          <CheckIcon data-icon={label ? "inline-start" : undefined} />
        ) : (
          <CopyIcon data-icon={label ? "inline-start" : undefined} />
        )}
        {label ? text : null}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copyState === "copied" ? "Copied" : ""}
      </span>
    </>
  )
})

/**
 * The code. A string child is wrapped in a `code` element (and split into
 * numbered lines with `lineNumbers`); other children, as highlighted code,
 * render as they are. `wrap` wraps long lines.
 */
function CodeBlockContent({
  className,
  children,
  style,
  wrap = false,
  lineNumbers = false,
  startLine = 1,
  ...props
}: React.ComponentProps<"pre"> & {
  wrap?: boolean
  lineNumbers?: boolean
  startLine?: number
}) {
  return (
    <pre
      data-slot="code-block-content"
      data-wrap={wrap || undefined}
      data-numbered={lineNumbers || undefined}
      dir="ltr"
      style={
        lineNumbers
          ? { counterReset: `line ${startLine - 1}`, ...style }
          : style
      }
      className={cn(
        "min-h-0 min-w-0 overflow-auto bg-transparent text-start font-mono outline-none group-data-[size=default]/code-block:px-4 group-data-[size=default]/code-block:py-3 group-data-[size=default]/code-block:leading-6 group-data-[size=sm]/code-block:p-3 group-data-[size=sm]/code-block:leading-5 data-wrap:break-words data-wrap:whitespace-pre-wrap",
        className
      )}
      {...props}
    >
      {typeof children === "string" ? (
        <code
          data-slot="code-block-code"
          className={cn(lineNumbers && "grid grid-cols-[auto_1fr]")}
        >
          {lineNumbers
            ? children
                .replace(/\n$/, "")
                .split("\n")
                .map((line, index) => (
                  <CodeBlockLine key={index}>{line}</CodeBlockLine>
                ))
            : children}
        </code>
      ) : (
        children
      )}
    </pre>
  )
}

const codeBlockLineVariants = cva(
  "relative block min-h-lh before:min-w-6 before:text-end before:text-muted-foreground in-data-numbered:col-span-2 in-data-numbered:grid in-data-numbered:grid-cols-subgrid in-data-numbered:gap-x-3 in-data-numbered:[counter-increment:line] in-data-numbered:before:content-[counter(line)] in-data-numbered:before:select-none",
  {
    variants: {
      variant: {
        default: "",
        added: "bg-success/10",
        removed: "bg-destructive/10",
        highlighted: "bg-muted",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function CodeBlockLine({
  className,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof codeBlockLineVariants>) {
  // An empty line holds a newline so copying a selection keeps blank lines.
  const empty =
    children === undefined ||
    children === null ||
    children === "" ||
    (Array.isArray(children) && children.length === 0)

  return (
    <span
      data-slot="code-block-line"
      data-variant={variant}
      className={cn(codeBlockLineVariants({ variant }), className)}
      {...props}
    >
      <span data-slot="code-block-line-content" className="min-w-0">
        {empty ? "\n" : children}
      </span>
    </span>
  )
}

function CodeBlockFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-footer"
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-2 px-3 pb-3 text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockContent,
  CodeBlockLine,
  CodeBlockFooter,
}
