import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

import {
  createServerConnection,
  DOWN_AFTER_MS,
} from "@/lib/smith/server-connection"

/** A connection whose health checks answer `healthy` at once. */
function setup() {
  let healthy = false
  const checks: Array<number> = []
  const connection = createServerConnection(() => {
    checks.push(Date.now())
    return Promise.resolve(healthy)
  })
  const reconnects = vi.fn()
  connection.onReconnect(reconnects)
  return {
    connection,
    checks,
    reconnects,
    setHealthy: (value: boolean) => {
      healthy = value
    },
  }
}

describe("server connection", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("goes from online to restarting on the restart event", async () => {
    const { connection, checks } = setup()
    connection.markOnline()
    connection.markRestarting()
    expect(connection.state()).toBe("restarting")
    // The first check waits: the old server still answers for a moment.
    expect(checks).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    expect(checks).toEqual([500])
    expect(connection.state()).toBe("restarting")
  })

  it("ignores other answers during a restart", () => {
    const { connection } = setup()
    connection.markOnline()
    connection.markRestarting()
    connection.markOnline()
    expect(connection.state()).toBe("restarting")
  })

  it("goes from online to reconnecting when a request fails", async () => {
    const { connection, checks } = setup()
    connection.markOnline()
    connection.check()
    await vi.advanceTimersByTimeAsync(0)
    expect(checks).toEqual([0])
    expect(connection.state()).toBe("reconnecting")
  })

  it("stays online when the health check answers", async () => {
    const { connection, setHealthy, reconnects } = setup()
    connection.markOnline()
    setHealthy(true)
    connection.check()
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.state()).toBe("online")
    expect(reconnects).not.toHaveBeenCalled()
  })

  it("checks every 500 ms for 15 s, then backs off", async () => {
    const { connection, checks } = setup()
    connection.markOnline()
    connection.markRestarting()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(checks).toHaveLength(30)
    expect(checks.every((time, index) => time === (index + 1) * 500)).toBe(true)
    await vi.advanceTimersByTimeAsync(15_000)
    // 15 s, then 2 s, 3 s, 5 s, 5 s, ...
    expect(checks.slice(30)).toEqual([17_000, 20_000, 25_000, 30_000])
  })

  it("is down after 20 s without the server", async () => {
    const { connection } = setup()
    connection.markOnline()
    connection.check()
    await vi.advanceTimersByTimeAsync(DOWN_AFTER_MS - 1)
    expect(connection.state()).toBe("reconnecting")
    await vi.advanceTimersByTimeAsync(1)
    expect(connection.state()).toBe("down")
    // A later failure does not leave "down".
    connection.check()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(connection.state()).toBe("down")
  })

  it("goes online and calls the reconnect listeners when health is ok", async () => {
    const { connection, setHealthy, reconnects } = setup()
    connection.markOnline()
    connection.markRestarting()
    await vi.advanceTimersByTimeAsync(1500)
    expect(reconnects).not.toHaveBeenCalled()
    setHealthy(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(connection.state()).toBe("online")
    expect(reconnects).toHaveBeenCalledTimes(1)
    // No more checks or a "down" later.
    await vi.advanceTimersByTimeAsync(DOWN_AFTER_MS)
    expect(connection.state()).toBe("online")
  })

  it("goes from down to online", async () => {
    const { connection, setHealthy, reconnects } = setup()
    connection.markOnline()
    connection.check()
    await vi.advanceTimersByTimeAsync(DOWN_AFTER_MS)
    expect(connection.state()).toBe("down")
    setHealthy(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(connection.state()).toBe("online")
    expect(reconnects).toHaveBeenCalledTimes(1)
  })

  it("ignores a check that started before the restart event", async () => {
    let answer: (ok: boolean) => void = () => undefined
    const connection = createServerConnection(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        })
    )
    connection.markOnline()
    connection.check()
    connection.markRestarting()
    answer(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.state()).toBe("restarting")
  })

  it("reports each state change", async () => {
    const { connection, setHealthy } = setup()
    const states: Array<string> = []
    connection.onChange(() => states.push(connection.state()))
    connection.markOnline()
    connection.markRestarting()
    await vi.advanceTimersByTimeAsync(DOWN_AFTER_MS)
    setHealthy(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(states).toEqual(["online", "restarting", "down", "online"])
  })
})
