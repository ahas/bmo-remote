import { Database } from "bun:sqlite";

import { storePath } from "./settings";

// The service's store, read on every connection for the port the relay dials (docs/api.md, 「The store」).
// The service makes and migrates it and the command writes it; the sidecar only reads it, and opens it once.

// How long a read waits on a writer before it gives up, as the service's own does.
const BUSY_MS = 5_000;

export interface StoreSql {
  get: (sql: string, ...params: string[]) => unknown;
}

let opened: Database | undefined;

export function useStoreSql(): StoreSql {
  if (opened === undefined) {
    const database = new Database(storePath(), { create: false });

    database.run(`PRAGMA busy_timeout = ${BUSY_MS}`);
    opened = database;
  }

  const database = opened;

  return { get: (sql, ...params) => database.query(sql).get(...params) };
}
