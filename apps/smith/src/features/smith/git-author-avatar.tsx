import * as React from "react"

import {
  gitAuthorAvatarFailed,
  gitAuthorAvatarUrl,
  gitAuthorColor,
  gitAuthorInitials,
  markGitAuthorAvatarFailed,
} from "@/features/smith/git-author"
import { cn } from "@/lib/utils"

/**
 * The round avatar of a commit author: the GitHub image of the email, or the
 * initials on a color of the author when there is no image.
 */
export function GitAuthorAvatar({
  name,
  email,
  size,
  className,
  style,
}: {
  name: string
  email: string
  /** The diameter in pixels. */
  size: number
  className?: string
  style?: React.CSSProperties
}) {
  const url = gitAuthorAvatarUrl(email, size > 32 ? 128 : 64)
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null)
  const showImage = Boolean(
    url && failedUrl !== url && !gitAuthorAvatarFailed(url)
  )
  const initials = gitAuthorInitials(name, email)

  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-sans leading-none font-semibold text-white select-none",
        className
      )}
      style={{
        width: size,
        height: size,
        backgroundColor: gitAuthorColor(name, email),
        fontSize: Math.max(
          7,
          Math.round(size * (initials.length > 1 ? 0.4 : 0.5))
        ),
        ...style,
      }}
    >
      {initials}
      {showImage && url ? (
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          className="absolute inset-0 size-full object-cover"
          onError={() => {
            markGitAuthorAvatarFailed(url)
            setFailedUrl(url)
          }}
        />
      ) : null}
    </span>
  )
}
