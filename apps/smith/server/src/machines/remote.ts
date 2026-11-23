/**
 * Commands that a hub runs on a remote machine through its transport: find
 * `node` and `smith`, read the server status, start the server, and
 * install Smith. A non-interactive SSH shell often has a short `PATH`, so the
 * search also looks in common places.
 */
import type { MachineCache, MachineProfile } from "./profiles.ts"
import {
  TransportError,
  lastLines,
  type MachineTransport,
} from "./transport.ts"

export const MIN_NODE = [22, 19] as const

/** The remote server needs this contract version and this feature. */
export const MIN_API_CONTRACT_VERSION = 2
export const HUB_FEATURE = "machine-hub"

/** No single quotes: the script goes to the remote shell in single quotes. */
const DISCOVER_SCRIPT = [
  // The PATH of an SSH command, before the search adds to it. Commands on
  // the remote machine keep it, so they find git and other tools (on NixOS
  // they are not in /usr/bin).
  'echo "path=$PATH"',
  // Smith installs into ~/.local, so its smith comes first.
  'P="$HOME/.local/bin:$PATH"',
  'for d in "$HOME/.volta/bin" "$HOME/.local/share/mise/shims" "$HOME/.local/share/pnpm" "$HOME/Library/pnpm" "$HOME/.bun/bin" /opt/homebrew/bin /usr/local/bin "$HOME"/.nvm/versions/node/*/bin "$HOME"/.local/share/mise/installs/node/*/bin "$HOME"/.local/share/fnm/node-versions/*/installation/bin; do P="$P:$d"; done',
  'echo "os=$(uname -s)"',
  'echo "home=$HOME"',
  "IFS=:",
  "for d in $P; do",
  '  [ -n "$d" ] || continue',
  // A shim folder (vite-plus, volta, mise) has no npm next to its node, so
  // report the folder of the real node binary, which has npm.
  '  if [ -x "$d/node" ]; then',
  '    r=$("$d/node" -e "process.stdout.write(process.execPath)" 2>/dev/null)',
  '    case "$r" in */node) r="${r%/node}" ;; *) r="$d" ;; esac',
  '    echo "node=$r $("$d/node" -v 2>/dev/null)"',
  "  fi",
  '  [ -x "$d/smith" ] && echo "smith=$d/smith"',
  "done",
  "exit 0",
].join("\n")

export type Discovery = {
  os?: string
  home?: string
  /** Directories with a `node`, and the version of each, in PATH order. */
  nodes: Array<{ dir: string; version: string }>
  smiths: string[]
  /** The PATH of an SSH command on the remote machine. */
  path?: string
}

export function parseDiscovery(stdout: string): Discovery {
  const result: Discovery = { nodes: [], smiths: [] }
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf("=")
    if (index < 0) continue
    const key = line.slice(0, index)
    const value = line.slice(index + 1).trim()
    if (key === "os") result.os = value
    else if (key === "home") result.home = value
    else if (key === "path") result.path = value
    else if (key === "node") {
      const space = value.lastIndexOf(" ")
      const dir = space > 0 ? value.slice(0, space) : value
      const version = space > 0 ? value.slice(space + 1) : ""
      if (!result.nodes.some((node) => node.dir === dir))
        result.nodes.push({ dir, version })
    } else if (key === "smith" && !result.smiths.includes(value))
      result.smiths.push(value)
  }
  return result
}

/** `v22.19.0` as numbers; undefined for anything else. */
export function parseVersion(value: string | undefined) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value?.trim() ?? "")
  return match ? match.slice(1, 4).map(Number) : undefined
}

export function versionAtLeast(value: string | undefined, minimum: number[]) {
  const version = parseVersion(value)
  if (!version) return false
  for (let index = 0; index < minimum.length; index += 1) {
    const left = version[index] ?? 0
    const right = minimum[index] ?? 0
    if (left !== right) return left > right
  }
  return true
}

/** The first `node` that is new enough. */
export function pickNode(discovery: Discovery) {
  return discovery.nodes.find((node) =>
    versionAtLeast(node.version, [...MIN_NODE])
  )
}

export async function discover(
  transport: MachineTransport,
  signal?: AbortSignal
) {
  const result = await transport.exec(["sh", "-c", DISCOVER_SCRIPT], {
    timeoutMs: 30_000,
    ...(signal ? { signal } : {}),
  })
  if (result.code !== 0)
    throw new TransportError(
      lastLines(result.stderr, 1) ||
        `The remote search for node failed (exit code ${result.code})`,
      result.code,
      lastLines(result.stderr)
    )
  return parseDiscovery(result.stdout)
}

/** Fill the cache from a search. */
export function cacheFromDiscovery(
  discovery: Discovery,
  previous: MachineCache = {}
): MachineCache {
  const node = pickNode(discovery)
  const cache: MachineCache = { ...previous }
  delete cache.nodeDir
  delete cache.nodeVersion
  delete cache.smithPath
  if (discovery.os) cache.os = discovery.os
  cache.shellPath = discovery.path ?? ""
  if (node) {
    cache.nodeDir = node.dir
    cache.nodeVersion = node.version
  }
  if (discovery.smiths[0]) cache.smithPath = discovery.smiths[0]
  return cache
}

/**
 * The PATH of remote commands: the found `node` first, then the PATH of an
 * SSH command there, then the usual system folders.
 */
export function remotePath(cache: Pick<MachineCache, "nodeDir" | "shellPath">) {
  const dirs = [
    cache.nodeDir,
    ...(cache.shellPath ?? "").split(":"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter((dir): dir is string => Boolean(dir))
  return [...new Set(dirs)].join(":")
}

/** A `smith` command with the found `node` in `PATH`. */
export function smithCommand(
  cache: MachineCache,
  profile: Pick<MachineProfile, "dataDir">,
  args: string[]
) {
  if (!cache.smithPath || !cache.nodeDir)
    throw new Error("smith or node was not found on the remote machine")
  return [
    "env",
    `PATH=${remotePath(cache)}`,
    "SMITH_OPEN=0",
    cache.smithPath,
    ...args,
    ...(profile.dataDir ? ["--data-dir", profile.dataDir] : []),
  ]
}

export type RemoteStatus = {
  pid: number
  port: number
  host: string
  version: string
}

/**
 * The status of the remote server: undefined when it is not running.
 * Throws when the command fails in another way.
 */
export async function remoteStatus(
  transport: MachineTransport,
  cache: MachineCache,
  profile: Pick<MachineProfile, "dataDir">,
  signal?: AbortSignal
): Promise<RemoteStatus | undefined> {
  const result = await transport.exec(
    smithCommand(cache, profile, ["status", "--json"]),
    { timeoutMs: 20_000, ...(signal ? { signal } : {}) }
  )
  if (
    result.code === 1 &&
    (!result.stdout.trim() || /not running/i.test(result.stdout))
  )
    return undefined
  if (result.code !== 0)
    throw new TransportError(
      lastLines(result.stderr, 1) ||
        `smith status failed with exit code ${result.code}`,
      result.code,
      lastLines(result.stderr)
    )
  let data: Partial<RemoteStatus>
  try {
    data = JSON.parse(result.stdout) as Partial<RemoteStatus>
  } catch {
    throw new TransportError(
      "smith status --json did not return JSON. Update Smith on the remote machine.",
      result.code,
      lastLines(result.stdout)
    )
  }
  if (typeof data.port !== "number" || typeof data.pid !== "number")
    throw new TransportError("smith status has no port", 0, "")
  return {
    pid: data.pid,
    port: data.port,
    host: String(data.host ?? ""),
    version: String(data.version ?? ""),
  }
}

export async function remoteVersion(
  transport: MachineTransport,
  cache: MachineCache
) {
  const result = await transport.exec(
    smithCommand(cache, { dataDir: null }, ["--version"]),
    { timeoutMs: 20_000 }
  )
  return result.code === 0 ? result.stdout.trim() : undefined
}

/** Whether the remote `smith` can work with a hub (`serve --detach`). */
export async function remoteSupportsHub(
  transport: MachineTransport,
  cache: MachineCache
) {
  const result = await transport.exec(
    smithCommand(cache, { dataDir: null }, ["--help"]),
    { timeoutMs: 20_000 }
  )
  return result.code === 0 && result.stdout.includes("--detach")
}

/** Start the remote server in the background on its loopback. */
export async function startRemote(
  transport: MachineTransport,
  cache: MachineCache,
  profile: Pick<MachineProfile, "dataDir">
) {
  const result = await transport.exec(
    smithCommand(cache, profile, [
      "serve",
      "--detach",
      "--no-open",
      "--host",
      "127.0.0.1",
    ]),
    { timeoutMs: 60_000 }
  )
  if (result.code !== 0)
    throw new TransportError(
      lastLines(result.stderr, 1) ||
        lastLines(result.stdout, 1) ||
        `smith serve failed with exit code ${result.code}`,
      result.code,
      lastLines(`${result.stdout}\n${result.stderr}`)
    )
}

/**
 * Install Smith with npm into `~/.local` on the remote host. This needs no
 * root and does not change the global packages of the remote `node`.
 */
export async function installRemote(
  transport: MachineTransport,
  nodeDir: string,
  version: string
) {
  const result = await transport.exec(
    [
      "sh",
      "-c",
      `PATH="${nodeDir}:$PATH:/usr/local/bin:/usr/bin:/bin"; exec npm install --global --prefix "$HOME/.local" @alivault/smith@${version}`,
    ],
    { timeoutMs: 10 * 60_000 }
  )
  if (result.code !== 0)
    throw new TransportError(
      lastLines(result.stderr, 1) || `npm failed with exit code ${result.code}`,
      result.code,
      lastLines(result.stderr, 12)
    )
}

/**
 * Restart the remote server so that it runs new files. Ask it to restart
 * itself, so that it stays under its launcher or systemd unit. Only a server
 * without a restart route is stopped and started again in the background.
 */
export async function restartRemote(
  transport: MachineTransport,
  cache: MachineCache,
  profile: Pick<MachineProfile, "dataDir">
) {
  const restarted = await transport.exec(
    smithCommand(cache, profile, ["restart"]),
    { timeoutMs: 13 * 60_000 }
  )
  if (restarted.code !== 0) {
    await transport.exec(smithCommand(cache, profile, ["stop", "--wait"]), {
      timeoutMs: 11 * 60_000,
    })
    await startRemote(transport, cache, profile)
  }
}

/**
 * Update Smith on the remote host over SSH: `smith update [version]` there,
 * which installs where that Smith is installed and restarts it. A `smith`
 * without `update` (or none) gets the install of `machine add` (npm into
 * `~/.local`) and a restart. A server that does not run is started.
 * Without `version`, the newest version on the remote's channel.
 */
export async function updateOverSsh(
  transport: MachineTransport,
  previous: MachineCache,
  profile: Pick<MachineProfile, "dataDir" | "label">,
  version: string | undefined,
  signal?: AbortSignal
): Promise<{ cache: MachineCache; upToDate?: string }> {
  let cache = previous
  if (!cache.smithPath || !cache.nodeDir || cache.shellPath === undefined)
    cache = cacheFromDiscovery(await discover(transport, signal), cache)
  if (!cache.nodeDir)
    throw new TransportError(
      `Node.js ${MIN_NODE.join(".")} or later was not found on ${profile.label}.`,
      127,
      ""
    )
  const help = cache.smithPath
    ? await transport.exec(smithCommand(cache, { dataDir: null }, ["--help"]), {
        timeoutMs: 20_000,
        ...(signal ? { signal } : {}),
      })
    : undefined
  let upToDate: string | undefined
  if (help?.code === 0 && help.stdout.includes("smith update")) {
    const result = await transport.exec(
      smithCommand(cache, profile, ["update", ...(version ? [version] : [])]),
      { timeoutMs: 13 * 60_000, ...(signal ? { signal } : {}) }
    )
    const output = `${result.stdout}\n${result.stderr}`
    if (result.code !== 0)
      throw new TransportError(
        lastLines(output, 2) ||
          `smith update failed with exit code ${result.code}`,
        result.code,
        lastLines(output, 12)
      )
    upToDate = /Smith (\S+) is up to date/.exec(result.stdout)?.[1]
  } else {
    if (!version)
      throw new Error(
        `smith on ${profile.label} is too old to look for a new version. Give a version.`
      )
    await installRemote(transport, cache.nodeDir, version)
    cache = cacheFromDiscovery(await discover(transport, signal), cache)
    if (await remoteStatus(transport, cache, profile, signal))
      await restartRemote(transport, cache, profile)
  }
  if (!(await remoteStatus(transport, cache, profile, signal)))
    await startRemote(transport, cache, profile)
  return { cache, ...(upToDate ? { upToDate } : {}) }
}

export type ConnectionProblem = {
  kind: "auth" | "stopped" | "update" | "setup" | "error"
  message: string
  /** The last lines of SSH or command errors. */
  detail?: string
  /** A URL to open, for example a Tailscale SSH check. */
  url?: string
}

const AUTH_PATTERNS = [
  /permission denied/i,
  /host key verification failed/i,
  /remote host identification has changed/i,
  /no matching host key/i,
  /too many authentication failures/i,
  /passphrase/i,
  /password/i,
  /authenticat/i,
  /login\.tailscale\.com/i,
  /to authenticate, visit/i,
]

/** Whether SSH failed because it needs the user, not because of the network. */
export function isAuthFailure(stderr: string) {
  return AUTH_PATTERNS.some((pattern) => pattern.test(stderr))
}

/** The first URL in SSH output, for example a Tailscale SSH check. */
export function firstUrl(text: string) {
  return /https:\/\/\S+/.exec(text)?.[0]?.replace(/[).,]+$/, "")
}
