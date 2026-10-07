import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Extension } from "../core/host.ts";

/** A working directory is not a sandbox. Run the whole application in a container if needed. */
export function computerExtension(workspace: string): Extension {
  return {
    name: "japa.computer",
    adapters: {
      environment:
        () =>
        ({ cwd }) =>
          new NodeExecutionEnv({ cwd: cwd ?? workspace }),
    },
    register: () => ({ ...CodingTools, name: "japa.computer" }),
  };
}
