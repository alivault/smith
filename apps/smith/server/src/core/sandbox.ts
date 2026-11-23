/**
 * The bash sandbox of profiles with `bash: "sandbox"` (`read-only` and
 * `reviewer`) or `bash: "sandbox-net"` (`researcher`). The filesystem is
 * read-only. `sandbox` has no network; `sandbox-net` has the network.
 *
 * Linux: each bash call runs in bubblewrap (`bwrap`).
 *
 * - The agent's repository (or its working directory) and the user's caches
 *   get a temporary overlay: a command can write there, for example a test
 *   build, but the changes are gone when the call ends. `/tmp` is a new,
 *   empty tmpfs; a working directory in it is mounted again on top. bwrap
 *   reads overlay sources from the host, so an overlay in /tmp works too.
 * - `sandbox` has no network. This also blocks Smith's own API on localhost,
 *   which has no login and could start an agent without the sandbox.
 *   `sandbox-net` shares the host network, localhost included.
 * - `/run/user/<uid>` is hidden, so the command cannot reach the user's
 *   systemd, D-Bus, the pty-host, or the ssh-agent, and start a process
 *   outside the sandbox.
 * - The command gets its own PID namespace and a new session, and it stops
 *   when the tool call stops.
 *
 * Overlayfs cannot go on a directory that has another mount inside it (for
 * example a FUSE mount in the home directory). Such a directory stays
 * read-only.
 *
 * macOS: each bash call runs under `sandbox-exec` with a Seatbelt policy
 * (`seatbeltPolicy`). It has no overlays: a write fails, except in the temp
 * directories (`/private/tmp`, `/private/var/folders`, which holds
 * `$TMPDIR`). A write in the repository fails also when the repository is in
 * a temp directory. The policy denies everything that it does not allow, so
 * the command cannot reach launchd services, the pty-host socket, or other
 * unix sockets. `sandbox-net` allows the network, but not localhost (Smith's
 * API) and not unix sockets other than the DNS resolver.
 *
 * Without bubblewrap or sandbox-exec, a sandboxed profile cannot use bash.
 */
import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/** The environment variable that carries the script into the sandbox. */
export const SANDBOX_SCRIPT_ENV = "SMITH_SANDBOX_SCRIPT"

/** The environment variable that carries the Seatbelt policy (macOS). */
export const SANDBOX_POLICY_ENV = "SMITH_SANDBOX_POLICY"

/** `sandbox`: no network. `sandbox-net`: with the network. */
export type SandboxMode = "sandbox" | "sandbox-net"

const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

/** Caches that commands such as test runners and package managers write. */
const CACHE_DIRS = [".cache", ".local/state", ".npm"]

let available: Promise<boolean> | undefined

/**
 * Whether the sandbox runs here: bubblewrap with the namespaces that the
 * sandbox needs (Linux), or sandbox-exec (macOS).
 */
export function sandboxAvailable() {
  available ??= (async () => {
    if (process.platform === "darwin") {
      if (!existsSync(SANDBOX_EXEC)) return false
      try {
        await run(SANDBOX_EXEC, ["-p", seatbeltPolicy({}), "/usr/bin/true"], {
          timeout: 10_000,
        })
        return true
      } catch {
        return false
      }
    }
    if (process.platform !== "linux") return false
    try {
      await run(
        "bwrap",
        ["--ro-bind", "/", "/", "--unshare-all", "--", "/bin/true"],
        { timeout: 10_000 }
      )
      return true
    } catch {
      return false
    }
  })()
  return available
}

/** The mount points in `/proc/self/mountinfo`. */
function mountPoints() {
  try {
    return readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .map((line) => line.split(" ")[4])
      .filter((point): point is string => Boolean(point))
      .map((point) =>
        point.replace(/\\([0-7]{3})/g, (_, code: string) =>
          String.fromCharCode(Number.parseInt(code, 8))
        )
      )
  } catch {
    return []
  }
}

/** The directories that get a temporary overlay, in mount order. */
export function overlayDirs(
  workDir: string,
  options: { home?: string; mounts?: readonly string[] } = {}
) {
  const home = resolve(options.home ?? homedir())
  const mounts = options.mounts ?? mountPoints()
  const hasMountInside = (dir: string) =>
    mounts.some((point) => point.startsWith(`${dir}/`))
  const candidates = [
    resolve(workDir),
    ...CACHE_DIRS.map((dir) => join(home, dir)),
  ]
  const dirs: string[] = []
  for (const dir of candidates) {
    if (dir === "/" || dir === home || dirs.includes(dir)) continue
    // A directory inside one that already has an overlay is covered.
    if (dirs.some((other) => dir.startsWith(`${other}/`))) continue
    if (!existsSync(dir) || hasMountInside(dir)) continue
    dirs.push(dir)
  }
  return dirs
}

/** Quote a word for a POSIX shell. */
function quote(word: string) {
  return /^[\w@%+=:,./-]+$/.test(word)
    ? word
    : `'${word.replace(/'/g, `'"'"'`)}'`
}

/** The bwrap arguments for a command in `cwd`, which overlays `overlays`. */
export function sandboxArgs(
  cwd: string,
  overlays: readonly string[],
  uid = process.getuid?.() ?? 0,
  options: { network?: boolean } = {}
) {
  const args = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
  ]
  const runtimeDir = `/run/user/${uid}`
  if (existsSync(runtimeDir)) args.push("--tmpfs", runtimeDir)
  for (const dir of overlays)
    args.push("--overlay-src", dir, "--tmp-overlay", dir)
  // A working directory in /tmp is under the new tmpfs: show it again,
  // read-only, when no overlay covers it.
  const covered = overlays.some(
    (dir) => cwd === dir || cwd.startsWith(`${dir}/`)
  )
  if ((cwd === "/tmp" || cwd.startsWith("/tmp/")) && !covered)
    args.push("--ro-bind", cwd, cwd)
  args.push("--unshare-all")
  if (options.network) args.push("--share-net")
  args.push("--die-with-parent", "--new-session", "--chdir", cwd)
  return args
}

/** The git repository root of `cwd`, or `cwd`. */
async function workDirOf(cwd: string) {
  try {
    const { stdout } = await run(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { timeout: 5000 }
    )
    return stdout.trim() || cwd
  } catch {
    return cwd
  }
}

/** A string in a Seatbelt policy. */
function sbplString(value: string) {
  return `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`
}

/** Directories where a sandboxed command may write (macOS real paths). */
const SEATBELT_TEMP_DIRS = ["/private/tmp", "/private/var/folders"]

/**
 * The Seatbelt policy of the macOS sandbox. It denies by default, then
 * allows: reads everywhere, processes, writes in the temp directories and to
 * the terminal devices, and the few system services that common tools need
 * (user lookups, logging). `workDir` (a real path) stays read-only, also in
 * a temp directory. With `network`, it allows the network and the services
 * of DNS and TLS, but not localhost and no unix socket except the DNS
 * resolver.
 */
export function seatbeltPolicy(options: {
  workDir?: string
  network?: boolean
}) {
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow file-read*)",
    "(allow file-write*",
    ...SEATBELT_TEMP_DIRS.map((dir) => `  (subpath ${sbplString(dir)})`),
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/dtracehelper") (regex #"^/dev/tty"))',
    "(allow sysctl-read)",
    "(allow ipc-posix-sem ipc-posix-shm)",
    "(allow pseudo-tty)",
    "(allow mach-lookup",
    '  (global-name "com.apple.system.opendirectoryd.libinfo")',
    '  (global-name "com.apple.system.logger")',
    '  (global-name "com.apple.system.notification_center")',
    '  (global-name "com.apple.PowerManagement.control"))',
  ]
  const workDir = options.workDir
  if (
    workDir &&
    workDir !== "/" &&
    !SEATBELT_TEMP_DIRS.some(
      (dir) => workDir === dir || dir.startsWith(`${workDir}/`)
    )
  )
    lines.push(`(deny file-write* (subpath ${sbplString(workDir)}))`)
  if (options.network)
    lines.push(
      "(allow network-outbound network-inbound system-socket)",
      "(allow mach-lookup",
      '  (global-name "com.apple.SystemConfiguration.configd")',
      '  (global-name "com.apple.SystemConfiguration.DNSConfiguration")',
      '  (global-name "com.apple.dnssd.service")',
      '  (global-name "com.apple.networkd")',
      '  (global-name "com.apple.trustd")',
      '  (global-name "com.apple.trustd.agent")',
      '  (global-name "com.apple.ocspd")',
      '  (global-name "com.apple.SecurityServer"))',
      // Smith's API listens on localhost and has no login.
      '(deny network-outbound (remote ip "localhost:*"))',
      // The pty-host and other local services listen on unix sockets.
      "(deny network-outbound (remote unix-socket))",
      '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))'
    )
  return lines.join("\n")
}

/**
 * Change a bash execution to run `script` in the sandbox. The script (and on
 * macOS the policy) goes in an environment variable, so it needs no quoting.
 */
export async function sandboxExecution(
  execution: {
    command: string
    cwd: string
    env: Record<string, string>
  },
  mode: SandboxMode = "sandbox"
) {
  const network = mode === "sandbox-net"
  const workDir = await workDirOf(execution.cwd)
  execution.env[SANDBOX_SCRIPT_ENV] = execution.command
  if (process.platform === "darwin") {
    execution.env[SANDBOX_POLICY_ENV] = seatbeltPolicy({
      workDir: await realpath(workDir).catch(() => workDir),
      network,
    })
    execution.command = `exec ${SANDBOX_EXEC} -p "$${SANDBOX_POLICY_ENV}" bash -c "$${SANDBOX_SCRIPT_ENV}"`
    return
  }
  const overlays = overlayDirs(workDir)
  execution.command = [
    "exec bwrap",
    ...sandboxArgs(execution.cwd, overlays, undefined, { network }).map(quote),
    `-- bash -c "$${SANDBOX_SCRIPT_ENV}"`,
  ].join(" ")
}
