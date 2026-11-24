import { describe, expect, it } from "vite-plus/test"

import {
  parseStackTrace,
  parseTestSummary,
  parseWebSources,
  stripAnsi,
} from "@/lib/smith/tool-output-detect"

const VITEST = ` RUN  v3.2.4 /repo

 ✓ src/app.test.ts (4 tests) 12ms
 ✗ src/util.test.ts (2 tests | 1 failed) 9ms
   × formats a duration 4ms
     → expected '1m 3s' to be '1m 03s'

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 5 passed (6)
   Duration  412ms`

const NODE = `✔ parses args (1.2ms)
✖ writes the report (3.1ms)
ℹ tests 2
ℹ suites 0
ℹ pass 1
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 54.2

✖ failing tests:

✖ writes the report (3.1ms)`

const JEST = `FAIL src/a.test.js
  ● adds numbers

Test Suites: 1 failed, 1 total
Tests:       1 failed, 2 passed, 3 total`

describe("parseTestSummary", () => {
  it("reads a Vitest run with its failures", () => {
    expect(parseTestSummary(VITEST)).toEqual({
      runner: "vitest",
      passed: 5,
      failed: 1,
      skipped: 0,
      total: 6,
      failures: [
        {
          name: "formats a duration",
          message: "expected '1m 3s' to be '1m 03s'",
        },
      ],
    })
  })

  it("reads Vitest output in color", () => {
    const colored = VITEST.replace("Tests", "\u001b[2mTests\u001b[22m")
    expect(parseTestSummary(colored)?.total).toBe(6)
  })

  it("reads a Node test run and lists each failure once", () => {
    expect(parseTestSummary(NODE)).toMatchObject({
      runner: "node",
      passed: 1,
      failed: 1,
      total: 2,
      failures: [{ name: "writes the report" }],
    })
  })

  it("reads a Jest run", () => {
    expect(parseTestSummary(JEST)).toMatchObject({
      runner: "jest",
      passed: 2,
      failed: 1,
      total: 3,
      failures: [{ name: "adds numbers" }],
    })
  })

  it("ignores other output", () => {
    expect(parseTestSummary("Tests  are fun (3)")).toBeNull()
    expect(parseTestSummary("ℹ tests 3")).toBeNull()
    expect(parseTestSummary("build ok")).toBeNull()
  })
})

describe("parseStackTrace", () => {
  it("reads the error and its frames", () => {
    const trace = parseStackTrace(`node:internal/run_main:123
TypeError: Cannot read properties of undefined (reading 'port')
    at start (/repo/src/app.ts:12:28)
    at /repo/src/index.ts:5:3
    at Module._compile (node:internal/modules/cjs/loader:1554:14)

Node.js v24.1.0`)
    expect(trace?.type).toBe("TypeError")
    expect(trace?.message).toBe(
      "Cannot read properties of undefined (reading 'port')"
    )
    expect(trace?.frames).toEqual([
      {
        raw: "at start (/repo/src/app.ts:12:28)",
        fn: "start",
        file: "/repo/src/app.ts",
        line: 12,
        column: 28,
        internal: false,
      },
      {
        raw: "at /repo/src/index.ts:5:3",
        file: "/repo/src/index.ts",
        line: 5,
        column: 3,
        internal: false,
      },
      {
        raw: "at Module._compile (node:internal/modules/cjs/loader:1554:14)",
        fn: "Module._compile",
        file: "node:internal/modules/cjs/loader",
        line: 1554,
        column: 14,
        internal: true,
      },
    ])
  })

  it("needs at least two frames", () => {
    expect(parseStackTrace("Error: nope\n    at x (/a.js:1:1)")).toBeNull()
    expect(parseStackTrace("Error: something went wrong")).toBeNull()
    expect(parseStackTrace("error: lowercase is a log line")).toBeNull()
  })
})

describe("parseWebSources", () => {
  it("reads numbered titles with their URLs, once each", () => {
    expect(
      parseWebSources(`**Sources:**
1. Vitest 3.2 is out!
   https://vitest.dev/blog/vitest-3-2
2. Reporters
   https://vitest.dev/guide/reporters
3. Again
   https://vitest.dev/guide/reporters`)
    ).toEqual([
      {
        title: "Vitest 3.2 is out!",
        url: "https://vitest.dev/blog/vitest-3-2",
      },
      { title: "Reporters", url: "https://vitest.dev/guide/reporters" },
    ])
  })

  it("finds nothing in plain text", () => {
    expect(parseWebSources("1. A list\n2. Without links")).toEqual([])
  })
})

describe("stripAnsi", () => {
  it("removes color codes", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red")
  })
})
