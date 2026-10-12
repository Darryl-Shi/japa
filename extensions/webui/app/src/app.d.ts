import type { WebuiBridge } from "$lib/protocol";

declare global {
  namespace App {
    interface Locals {
      webui: WebuiBridge;
    }
    interface Error {
      message: string;
    }
  }
}

export {};
