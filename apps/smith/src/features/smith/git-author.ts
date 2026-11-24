/**
 * The author avatar of a commit: the image URL from the email, the initials
 * and the color of the fallback, and a cache of the images that failed.
 */

// `<id>+<login>@users.noreply.github.com` or `<login>@users.noreply.github.com`.
// A login has letters, digits, and dashes; an app (bot) ends in `[bot]`.
const GITHUB_NOREPLY_EMAIL =
  /^(?:(\d+)\+)?([a-z\d](?:[a-z\d-]*[a-z\d])?(?:\[bot\])?)@users\.noreply\.github\.com$/i

/** The GitHub user of a GitHub noreply email, or null. */
export function gitHubNoreplyUser(email: string) {
  const match = GITHUB_NOREPLY_EMAIL.exec(email.trim())
  if (!match) return null
  return { id: match[1] ?? "", login: match[2]! }
}

/**
 * The avatar image of an email, from GitHub. A noreply email gives the
 * avatar of its user: by ID when the email has one (the ID does not change
 * when the user renames, and bots have no avatar by login), else by login.
 * Other emails use GitHub's avatar of the account that has the email. Null
 * when there is no email.
 */
export function gitAuthorAvatarUrl(email: string, size = 64) {
  const value = email.trim()
  if (!value || !value.includes("@")) return null
  const user = gitHubNoreplyUser(value)
  if (user?.id)
    return `https://avatars.githubusercontent.com/u/${user.id}?s=${size}`
  if (user)
    return `https://avatars.githubusercontent.com/${encodeURIComponent(user.login)}?s=${size}`
  return `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(value)}&s=${size}`
}

function firstLetter(word: string) {
  return Array.from(word).find((character) => /[\p{L}\p{N}]/u.test(character))
}

/**
 * One or two letters for an author: the first letters of the first and the
 * last word of the name, else the first letter of the email.
 */
export function gitAuthorInitials(name: string, email = "") {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .map(firstLetter)
    .filter((letter): letter is string => Boolean(letter))
  if (words.length > 1)
    return `${words[0]}${words[words.length - 1]}`.toUpperCase()
  if (words.length === 1) return words[0]!.toUpperCase()
  const fromEmail = firstLetter(email.split("@")[0] ?? "")
  return fromEmail ? fromEmail.toUpperCase() : "?"
}

/**
 * Fill colors for the initials, with white text. They are dark enough for
 * white text and bright enough to show on a dark background.
 */
export const GIT_AUTHOR_COLORS = [
  "#0284c7", // sky
  "#db2777", // pink
  "#059669", // emerald
  "#d97706", // amber
  "#7c3aed", // violet
  "#0d9488", // teal
  "#4f46e5", // indigo
  "#e11d48", // rose
  "#ea580c", // orange
  "#2563eb", // blue
] as const

/** FNV-1a: a small, stable hash of a string. */
function hashString(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** The color of an author: the same email (or name) gives the same color. */
export function gitAuthorColor(name: string, email = "") {
  const key = (email.trim() || name.trim()).toLowerCase()
  return GIT_AUTHOR_COLORS[hashString(key) % GIT_AUTHOR_COLORS.length]!
}

// The images that failed in this page, so that the rows do not load them
// again each time they render.
const failedAvatarUrls = new Set<string>()

export function gitAuthorAvatarFailed(url: string) {
  return failedAvatarUrls.has(url)
}

export function markGitAuthorAvatarFailed(url: string) {
  failedAvatarUrls.add(url)
}
