import { homedir } from "node:os"

import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"

/** The execution environment of an agent: `HarnessOptions.env`. */
export function executionEnv(cwd: string | undefined) {
  return new NodeExecutionEnv({ cwd: cwd ?? homedir() })
}
