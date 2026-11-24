import * as React from "react"
import { XIcon } from "lucide-react"

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentMedia,
} from "@/components/ui/attachment"
import { cn } from "@/lib/utils"

/**
 * An image attached to a prompt, from the Attachment part of Prompt Input
 * (https://ui.shadcn.com/docs/ai-elements/base/prompt-input): the image at
 * its own aspect ratio, with a round remove button in its corner. Sizes:
 * `lg` in the composer, `sm` in the queue editor and in answers.
 */
function ImageAttachment({
  alt = "Attachment preview",
  disabled = false,
  onRemove,
  onRemoveMouseDown,
  size = "sm",
  src,
}: {
  alt?: string
  disabled?: boolean
  onRemove?: () => void
  /** For a remove button that must not take the focus. */
  onRemoveMouseDown?: React.MouseEventHandler<HTMLButtonElement>
  size?: "sm" | "md" | "lg"
  src: string
}) {
  return (
    <Attachment className="min-w-0 shrink-0 border-0 bg-transparent p-0! focus-within:ring-0">
      <AttachmentMedia
        variant="image"
        className={cn(
          "aspect-auto w-auto bg-transparent opacity-100 *:[img]:aspect-auto *:[img]:w-auto *:[img]:rounded-[inherit] *:[img]:border",
          size === "lg" ? "rounded-lg" : "rounded-md"
        )}
      >
        <img
          src={src}
          alt={alt}
          className={
            size === "lg" ? "h-20 max-w-60" : size === "md" ? "h-16" : "h-12"
          }
        />
      </AttachmentMedia>
      {onRemove ? (
        <AttachmentActions
          className={cn(
            "absolute",
            size === "lg" ? "top-1 right-1" : "top-0.5 right-0.5"
          )}
        >
          <AttachmentAction
            aria-label="Remove image"
            title="Remove image"
            disabled={disabled}
            className={cn(
              "rounded-full bg-background/90 shadow-sm hover:bg-background disabled:cursor-not-allowed disabled:opacity-60",
              size === "lg" ? "size-7" : "size-5"
            )}
            onMouseDown={onRemoveMouseDown}
            onClick={onRemove}
          >
            <XIcon className="size-3" />
          </AttachmentAction>
        </AttachmentActions>
      ) : null}
    </Attachment>
  )
}

export { ImageAttachment }
