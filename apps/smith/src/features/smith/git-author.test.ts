import { describe, expect, it } from "vite-plus/test"

import {
  GIT_AUTHOR_COLORS,
  gitAuthorAvatarFailed,
  gitAuthorAvatarUrl,
  gitAuthorColor,
  gitAuthorInitials,
  gitHubNoreplyUser,
  markGitAuthorAvatarFailed,
} from "@/features/smith/git-author"

describe("gitHubNoreplyUser", () => {
  it("reads the ID and the login", () => {
    expect(gitHubNoreplyUser("123+octo-cat@users.noreply.github.com")).toEqual({
      id: "123",
      login: "octo-cat",
    })
    expect(gitHubNoreplyUser("octocat@users.noreply.github.com")).toEqual({
      id: "",
      login: "octocat",
    })
    expect(
      gitHubNoreplyUser("41898282+github-actions[bot]@users.noreply.github.com")
    ).toEqual({ id: "41898282", login: "github-actions[bot]" })
  })

  it("ignores other emails", () => {
    expect(gitHubNoreplyUser("dev@example.com")).toBeNull()
    expect(gitHubNoreplyUser("a@users.noreply.github.com.evil")).toBeNull()
    expect(gitHubNoreplyUser("-bad@users.noreply.github.com")).toBeNull()
  })
})

describe("gitAuthorAvatarUrl", () => {
  it("uses the user of a noreply email", () => {
    expect(gitAuthorAvatarUrl("123+octocat@users.noreply.github.com")).toBe(
      "https://avatars.githubusercontent.com/u/123?s=64"
    )
    expect(gitAuthorAvatarUrl("octocat@users.noreply.github.com")).toBe(
      "https://avatars.githubusercontent.com/octocat?s=64"
    )
  })

  it("asks GitHub for other emails, encoded", () => {
    expect(gitAuthorAvatarUrl(" a+b@example.com ", 32)).toBe(
      "https://avatars.githubusercontent.com/u/e?email=a%2Bb%40example.com&s=32"
    )
  })

  it("gives null without an email", () => {
    expect(gitAuthorAvatarUrl("")).toBeNull()
    expect(gitAuthorAvatarUrl("not-an-email")).toBeNull()
  })
})

describe("gitAuthorInitials", () => {
  it("takes the first and the last word", () => {
    expect(gitAuthorInitials("Ali Abbas")).toBe("AA")
    expect(gitAuthorInitials("mary ann de souza")).toBe("MS")
    expect(gitAuthorInitials("john.doe")).toBe("JD")
  })

  it("takes one letter for one word", () => {
    expect(gitAuthorInitials("bob")).toBe("B")
    expect(gitAuthorInitials("élodie")).toBe("É")
  })

  it("skips signs and falls back to the email", () => {
    expect(gitAuthorInitials("(bot) Deploy")).toBe("BD")
    expect(gitAuthorInitials("", "zed@example.com")).toBe("Z")
    expect(gitAuthorInitials("  ", "")).toBe("?")
  })
})

describe("gitAuthorColor", () => {
  it("is stable and from the palette", () => {
    const color = gitAuthorColor("Ali", "ali@example.com")
    expect(GIT_AUTHOR_COLORS).toContain(color)
    expect(gitAuthorColor("Other name", "ALI@example.com")).toBe(color)
    expect(gitAuthorColor("Ali")).toBe(gitAuthorColor("ali"))
  })

  it("spreads authors over the palette", () => {
    const colors = new Set(
      Array.from({ length: 50 }, (_, index) =>
        gitAuthorColor("", `user${index}@example.com`)
      )
    )
    expect(colors.size).toBeGreaterThan(5)
  })
})

describe("the avatar failure cache", () => {
  it("remembers a failed image", () => {
    const url = "https://avatars.githubusercontent.com/u/e?email=x&s=64"
    expect(gitAuthorAvatarFailed(url)).toBe(false)
    markGitAuthorAvatarFailed(url)
    expect(gitAuthorAvatarFailed(url)).toBe(true)
  })
})
