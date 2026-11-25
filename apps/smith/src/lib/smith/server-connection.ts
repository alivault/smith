/**
 * Whether the page can reach its Smith server (the hub). When the server is
 * down, every request fails. The page then shows one small status pill
 * (`ServerConnectionPill`) instead of one error toast for each failed
 * request, and it checks the server again until it answers.
 *
 * The states:
 * - `unknown`: nothing came in yet.
 * - `online`: the server answers.
 * - `restarting`: the server said that it restarts (`server_restarting`).
 * - `reconnecting`: a request failed and the server does not answer.
 * - `down`: the server did not answer for `DOWN_AFTER_MS`.
 *
 * online → restarting (event) | reconnecting (failed request);
 * restarting | reconnecting → online (health ok) | down (no answer in 20 s);
 * down → online.
 */
import * as React from "react"

import { LOCAL_MACHINE_ID, machineApiUrl } from "@/lib/smith/machine"

export type ServerConnectionState =
  | "unknown"
  | "online"
  | "restarting"
  | "reconnecting"
  | "down"

export const SERVER_UNREACHABLE_MESSAGE = "Smith cannot reach its server."

/** The server event that comes just before a restart. */
export const SERVER_RESTARTING_EVENT = "server_restarting"

/** A request that failed because the Smith server did not answer. */
export class ServerUnreachableError extends Error {
  constructor() {
    super(SERVER_UNREACHABLE_MESSAGE)
    this.name = "ServerUnreachableError"
  }
}

/**
 * Whether a failed response comes from a gateway in front of a stopped
 * server, such as the Vite proxy or a reverse proxy. The Smith server sends
 * JSON with its errors, so a 502, 503, or 504 without JSON is not from it.
 */
export function isGatewayFailure(status: number, body: string) {
  if (![502, 503, 504].includes(status)) return false
  try {
    JSON.parse(body)
    return false
  } catch {
    return true
  }
}

/** Whether the page has no server now, so server actions must wait. */
export function isServerLost(state: ServerConnectionState) {
  return state === "restarting" || state === "reconnecting" || state === "down"
}

/** Check every 500 ms for this long after the server went away... */
export const FAST_RETRY_MS = 15_000
export const FAST_RETRY_DELAY_MS = 500
/** ...then less often. */
export const SLOW_RETRY_DELAYS_MS = [2000, 3000, 5000]
/** Without an answer for this long, the server is down. */
export const DOWN_AFTER_MS = 20_000

/** Whether the server answers its health check and is not stopping. */
async function fetchServerHealth() {
  try {
    const response = await fetch(
      machineApiUrl(LOCAL_MACHINE_ID, "/api/system/health"),
      { cache: "no-store", signal: AbortSignal.timeout(5000) }
    )
    if (!response.ok) return false
    const body = (await response.json().catch(() => ({}))) as {
      phase?: unknown
    }
    // A server that stops or restarts still answers for a moment.
    return body.phase !== "draining"
  } catch {
    return false
  }
}

export type ServerConnection = ReturnType<typeof createServerConnection>

export function createServerConnection(
  checkHealth: () => Promise<boolean> = fetchServerHealth
) {
  let state: ServerConnectionState = "unknown"
  const listeners = new Set<() => void>()
  const reconnectListeners = new Set<() => void>()
  let checking = false
  // A check that started before a restart event can see the old server.
  let generation = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let downTimer: ReturnType<typeof setTimeout> | undefined
  /** When the server went away. */
  let lostAt = 0
  /** Checks after the fast ones, for the back-off. */
  let slowRetryCount = 0

  function setState(next: ServerConnectionState) {
    if (state === next) return
    const reconnected = isServerLost(state) && next === "online"
    state = next
    for (const listener of listeners) listener()
    if (reconnected) for (const listener of reconnectListeners) listener()
  }

  function clearTimers() {
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    if (downTimer !== undefined) clearTimeout(downTimer)
    retryTimer = undefined
    downTimer = undefined
  }

  function online() {
    clearTimers()
    setState("online")
  }

  /** The server went away: check it again soon, and fall to `down` later. */
  function lose(next: "restarting" | "reconnecting") {
    if (!isServerLost(state)) {
      lostAt = Date.now()
      slowRetryCount = 0
      clearTimers()
      downTimer = setTimeout(() => {
        downTimer = undefined
        if (isServerLost(state)) setState("down")
      }, DOWN_AFTER_MS)
    }
    // "down" stays "down" until the server answers.
    if (state !== "down") setState(next)
    scheduleRetry()
  }

  function scheduleRetry() {
    if (retryTimer !== undefined) return
    let delay = FAST_RETRY_DELAY_MS
    if (Date.now() - lostAt >= FAST_RETRY_MS) {
      delay =
        SLOW_RETRY_DELAYS_MS[
          Math.min(slowRetryCount, SLOW_RETRY_DELAYS_MS.length - 1)
        ]!
      slowRetryCount += 1
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      check()
    }, delay)
  }

  function check() {
    if (checking) return
    checking = true
    const started = generation
    void checkHealth().then((ok) => {
      checking = false
      if (started !== generation) {
        // A restart event came while this check ran: check again later.
        if (isServerLost(state)) scheduleRetry()
        return
      }
      if (ok) online()
      else lose(state === "restarting" ? "restarting" : "reconnecting")
    })
  }

  return {
    state: () => state,

    /**
     * Something from the server came in: it is reachable. During a restart,
     * only the health check counts: the old server still answers for a
     * moment before it exits.
     */
    markOnline() {
      if (state === "restarting") return
      online()
    },

    /** The server said that it restarts now. */
    markRestarting() {
      generation += 1
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = undefined
      lose("restarting")
    },

    /**
     * A request or stream failed in a way that can mean that the server is
     * down. Ask the server for its health. When it does not answer, the
     * page reconnects until a later check gets an answer.
     */
    check() {
      if (retryTimer !== undefined) return
      check()
    },

    /** Call `listener` each time the server answers again after a loss. */
    onReconnect(listener: () => void) {
      reconnectListeners.add(listener)
      return () => {
        reconnectListeners.delete(listener)
      }
    },

    /** Call `listener` each time the connection state changes. */
    onChange(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const connection = createServerConnection()

export function markServerOnline() {
  connection.markOnline()
}

export function markServerRestarting() {
  connection.markRestarting()
}

export function checkServerConnection() {
  connection.check()
}

export function serverConnectionState() {
  return connection.state()
}

export function onServerReconnect(listener: () => void) {
  return connection.onReconnect(listener)
}

export function onServerConnectionChange(listener: () => void) {
  return connection.onChange(listener)
}

export function useServerConnection() {
  return React.useSyncExternalStore(
    onServerConnectionChange,
    serverConnectionState,
    serverConnectionState
  )
}
