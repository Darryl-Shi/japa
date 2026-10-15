import type { IncomingMessage } from "node:http";
import type { WebuiBridge, WebuiRequest } from "$lib/protocol";

declare global {
  namespace App {
    interface Locals {
      webui: WebuiBridge;
      /** The signed-in web UI user's name (set by the surface's session gate). */
      user: string | undefined;
      /** Whether web UI users exist. */
      users: WebuiRequest["users"];
    }
    interface Platform {
      /** adapter-node's Node request. */
      req?: IncomingMessage;
    }
    interface Error {
      message: string;
    }
  }
}

export {};
