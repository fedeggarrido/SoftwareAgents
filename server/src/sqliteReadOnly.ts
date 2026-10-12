import * as fs from 'fs';

/** The read surface of a node:sqlite connection that observers use. */
export interface ReadOnlyDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
  close(): void;
}

/**
 * Open an existing SQLite file read-only, or undefined when it is missing or
 * node:sqlite is unavailable (Node 22.5+; older hosts simply observe nothing).
 * Observers never create, migrate or write the databases they watch.
 */
export function openReadOnly(file: string): ReadOnlyDb | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (f: string, o: { readOnly: boolean }) => ReadOnlyDb;
    };
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return undefined;
  }
}

export function readRows<T>(file: string, sql: string, ...params: unknown[]): T[] | undefined {
  const db = openReadOnly(file);
  if (!db) return undefined;
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return undefined; // table not created yet, or locked mid-write: retry next poll
  } finally {
    db.close();
  }
}
