import { Database, SQLiteError } from "bun:sqlite";

import { storePath } from "./settings";

// The service's store, read on every connection for the port the relay dials (docs/api.md, 「The store」).
// The service makes and migrates it and the command writes it; the sidecar only reads it, and opens it once.

// How often a read that finds the file locked by a writer looks again (ms): it waits for the lock however long
// the writer holds it.
const LOOK_AGAIN_MS = 5;

export interface StoreSql {
  get: (sql: string, ...params: string[]) => Promise<unknown>;
}

let opened: Database | undefined;

// Whether SQLite answered that another connection holds the lock.
function locked(error: unknown): boolean {
  return error instanceof SQLiteError && (error.code?.startsWith("SQLITE_BUSY") ?? false);
}

export function useStoreSql(): StoreSql {
  opened ??= new Database(storePath(), { create: false });

  const database = opened;

  return {
    get: async (sql, ...params) => {
      for (;;) {
        try {
          return database.query(sql).get(...params);
        } catch (error) {
          if (!locked(error)) throw error;

          await Bun.sleep(LOOK_AGAIN_MS);
        }
      }
    }
  };
}
