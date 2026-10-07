import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { homedir } from "node:os";
import { defineJapaExtension, type EnvironmentAdapter } from "../../src/sdk.ts";

const local: EnvironmentAdapter = {
  name: "local",
  create: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? homedir() }),
};

export default defineJapaExtension({
  name: "local-env",
  summary: "Runs tools on this machine's file system and shell",
  provides: { environment: [local] },
});
