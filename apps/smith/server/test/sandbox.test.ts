import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"

import { findProfile, sandboxInstructions } from "../src/core/profiles.ts"
import {
  overlayDirs,
  sandboxArgs,
  sandboxAvailable,
  sandboxExecution,
  seatbeltPolicy,
  type SandboxMode,
} from "../src/core/sandbox.ts"
import { tempDir } from "./support.ts"

const run = promisify(execFile)

void test("read-only and reviewer run bash in the sandbox", () => {
  assert.equal(findProfile("read-only")?.bash, "sandbox")
  assert.equal(findProfile("reviewer")?.bash, "sandbox")
  assert.equal(findProfile("researcher")?.bash, "sandbox-net")
  assert.equal(findProfile("builder")?.bash, undefined)
  assert.equal(findProfile("full")?.bash, undefined)
})

void test("overlays skip the home directory, nested directories, and directories with mounts", async () => {
  const home = await tempDir()
  for (const dir of [".cache", ".npm", "repo/sub", "fuse"])
    await mkdir(join(home, dir), { recursive: true })
  const mounts = ["/", join(home, "repo", "sub")]
  assert.deepEqual(overlayDirs(join(home, "repo"), { home, mounts }), [
    join(home, ".cache"),
    join(home, ".npm"),
  ])
  assert.deepEqual(overlayDirs(home, { home, mounts: ["/"] }), [
    join(home, ".cache"),
    join(home, ".npm"),
  ])
  assert.deepEqual(overlayDirs(join(home, ".cache"), { home, mounts: [] }), [
    join(home, ".cache"),
    join(home, ".npm"),
  ])
  assert.deepEqual(
    overlayDirs(join(home, "repo"), { home, mounts: [] }).slice(0, 1),
    [join(home, "repo")]
  )
})

void test("sandbox arguments: read-only root, no network, overlays", () => {
  const args = sandboxArgs("/work/repo", ["/work/repo"], 4242)
  assert.deepEqual(args.slice(0, 3), ["--ro-bind", "/", "/"])
  assert.ok(args.includes("--unshare-all"))
  assert.ok(!args.includes("--share-net"))
  const overlay = args.indexOf("--overlay-src")
  assert.deepEqual(args.slice(overlay, overlay + 4), [
    "--overlay-src",
    "/work/repo",
    "--tmp-overlay",
    "/work/repo",
  ])
  assert.equal(args.at(-1), "/work/repo")
  const net = sandboxArgs("/work/repo", [], 4242, { network: true })
  assert.ok(net.includes("--unshare-all"))
  assert.ok(net.indexOf("--share-net") > net.indexOf("--unshare-all"))
})

void test("the Seatbelt policy denies writes and the network, except where it allows them", () => {
  const policy = seatbeltPolicy({ workDir: "/private/tmp/repo" })
  assert.match(policy, /^\(version 1\)\n\(deny default\)/)
  assert.match(policy, /\(allow file-read\*\)/)
  assert.match(policy, /\(subpath "\/private\/var\/folders"\)/)
  assert.match(
    policy,
    /\(deny file-write\* \(subpath "\/private\/tmp\/repo"\)\)/
  )
  assert.doesNotMatch(policy, /network/)
  // A temp root itself is not denied, and a quote in a path is escaped.
  assert.doesNotMatch(
    seatbeltPolicy({ workDir: "/private/tmp" }),
    /deny file-write/
  )
  assert.match(seatbeltPolicy({ workDir: '/a"b' }), /"\/a\\"b"/)
  const net = seatbeltPolicy({ network: true })
  assert.match(net, /\(allow network-outbound network-inbound system-socket\)/)
  assert.match(net, /\(deny network-outbound \(remote ip "localhost:\*"\)\)/)
  assert.match(net, /\(deny network-outbound \(remote unix-socket\)\)/)
})

void test("the sandbox instructions name what each platform does", () => {
  assert.match(sandboxInstructions("sandbox", "darwin"), /no network/)
  assert.match(sandboxInstructions("sandbox", "darwin"), /fails/)
  assert.match(sandboxInstructions("sandbox", "linux"), /gone when/)
  assert.match(sandboxInstructions("sandbox-net", "darwin"), /not localhost/)
  assert.match(sandboxInstructions("sandbox-net", "linux"), /git fetch/)
  assert.doesNotMatch(
    sandboxInstructions("sandbox", "linux"),
    /with the network/
  )
})

/** Run `command` in the sandbox of `mode` in `cwd`; returns stdout. */
async function sandboxed(command: string, cwd: string, mode: SandboxMode) {
  const execution = { command, cwd, env: {} as Record<string, string> }
  await sandboxExecution(execution, mode)
  const { stdout } = await run("bash", ["-c", execution.command], {
    cwd,
    env: { ...process.env, ...execution.env },
  })
  return stdout
}

/** Whether this host reaches example.com, outside the sandbox. */
async function online() {
  try {
    await run("curl", [
      "-sS",
      "--max-time",
      "5",
      "-o",
      "/dev/null",
      "https://example.com",
    ])
    return true
  } catch {
    return false
  }
}

const darwinSkip =
  (process.platform !== "darwin" && "Seatbelt is macOS only") ||
  (!(await sandboxAvailable()) && "sandbox-exec is not available")

void test(
  "Seatbelt: a write in the repository fails, a write in TMPDIR works, git log works",
  { skip: darwinSkip },
  async () => {
    const dir = await tempDir()
    await run("git", ["init", "-q", dir])
    await run("git", [
      "-C",
      dir,
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "first",
    ])
    await writeFile(join(dir, "file.txt"), "before\n")
    const tmp = join(
      await realpath(tmpdir()),
      `smith-sandbox-${process.pid}.txt`
    )
    const stdout = await sandboxed(
      [
        "echo changed > file.txt 2>/dev/null || echo repo-refused",
        "mkdir sub 2>/dev/null || echo mkdir-refused",
        `echo ok > ${tmp} && cat ${tmp}`,
        "git log --oneline | grep -c first",
        "echo x > ~/.smith-sandbox-test 2>/dev/null || echo home-refused",
      ].join("\n"),
      dir,
      "sandbox"
    )
    assert.match(stdout, /repo-refused/)
    assert.match(stdout, /mkdir-refused/)
    assert.match(stdout, /^ok$/m)
    assert.match(stdout, /^1$/m)
    assert.match(stdout, /home-refused/)
    assert.equal((await run("cat", [join(dir, "file.txt")])).stdout, "before\n")
    await run("trash", [tmp]).catch(() => undefined)
  }
)

void test(
  "Seatbelt: no network in sandbox; the network but not localhost in sandbox-net",
  { skip: darwinSkip },
  async () => {
    const dir = await tempDir()
    const server = createServer((socket) => socket.end("hello\n"))
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    const port = (server.address() as { port: number }).port
    const local = `curl -sS --max-time 3 telnet://127.0.0.1:${port} </dev/null >/dev/null 2>&1 && echo local-ok || echo local-refused`
    const remote =
      "curl -sS --max-time 5 -o /dev/null https://example.com 2>/dev/null && echo net-ok || echo net-refused"
    try {
      const closed = await sandboxed(`${local}\n${remote}`, dir, "sandbox")
      assert.match(closed, /local-refused/)
      assert.match(closed, /net-refused/)
      const open = await sandboxed(`${local}\n${remote}`, dir, "sandbox-net")
      assert.match(open, /local-refused/)
      if (await online()) assert.match(open, /net-ok/)
    } finally {
      server.close()
    }
  }
)

void test(
  "bubblewrap: a sandboxed command cannot keep a change or reach the network",
  {
    skip:
      (process.platform !== "linux" && "bubblewrap is Linux only") ||
      (!(await sandboxAvailable()) && "bubblewrap is not available"),
  },
  async () => {
    const dir = await tempDir()
    await run("git", ["init", "-q", dir])
    await writeFile(join(dir, "file.txt"), "before\n")
    const execution = {
      command: [
        "echo changed > file.txt && cat file.txt",
        "echo new > created.txt && echo created",
        "echo x > /etc/smith-sandbox-test 2>/dev/null || echo outside-refused",
        "curl -s -m 3 http://example.com >/dev/null 2>&1 || echo no-network",
      ].join("\n"),
      cwd: dir,
      env: {} as Record<string, string>,
    }
    await sandboxExecution(execution)
    const { stdout } = await run("bash", ["-c", execution.command], {
      cwd: dir,
      env: { ...process.env, ...execution.env },
    })
    assert.match(stdout, /changed/)
    assert.match(stdout, /created/)
    assert.match(stdout, /outside-refused/)
    assert.match(stdout, /no-network/)
    // Nothing stays after the command ends.
    assert.equal((await run("cat", [join(dir, "file.txt")])).stdout, "before\n")
    assert.ok(!existsSync(join(dir, "created.txt")))
  }
)
