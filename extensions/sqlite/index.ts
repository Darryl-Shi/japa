import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { join } from "node:path";
import { defineJapaExtension, type StorageAdapter } from "../../src/sdk.ts";

const storage: StorageAdapter = {
  name: "sqlite",
  open: async (config, { home }) =>
    openNodeSqliteStorage(typeof config.file === "string" ? config.file : join(home, "state.db")),
};

export default defineJapaExtension({
  name: "sqlite",
  summary: "Stores japa's state in a local SQLite database",
  provides: { storage: [storage] },
});
