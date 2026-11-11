import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { FeaturesReadError } from '../../../core/src/messages.js';
import { resolveInside } from '../pathGuard.js';
import { runMigrations } from './migrations.js';
import { gitObjectReader } from './readOnlyGit.js';

export const MIN_PANEL_SCHEMA_VERSION = 15;

/** Number of known migrations, derived by migrating a scratch in-memory database. */
function latestSchemaVersion(): number {
  const scratch = new DatabaseSync(':memory:');
  try {
    runMigrations(scratch);
    return Number(
      scratch.prepare('SELECT version FROM schema_version WHERE singleton = 1').get()?.version,
    );
  } finally {
    scratch.close();
  }
}

export class FeaturesReadFailure extends Error {
  constructor(readonly reason: FeaturesReadError) {
    super(reason);
  }
}

/** Resolve Git metadata using files only, including linked worktrees. */
export function gitCommonDir(root: string): string {
  const marker = path.join(fs.realpathSync.native(root), '.git');
  let gitDir = marker;
  if (!fs.statSync(marker).isDirectory()) {
    const match = /^gitdir: (.+)\s*$/.exec(fs.readFileSync(marker, 'utf8').trim());
    if (!match) throw new Error('Invalid gitdir');
    gitDir = path.resolve(root, match[1]);
  }
  gitDir = fs.realpathSync.native(gitDir);
  const commonFile = path.join(gitDir, 'commondir');
  return fs.existsSync(commonFile)
    ? fs.realpathSync.native(path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim()))
    : gitDir;
}

/** Conservative ancestry evidence. Missing/unreadable objects never imply a merge. */
export function readMainAncestors(root: string): ReadonlySet<string> {
  const ancestors = new Set<string>();
  try {
    const common = gitCommonDir(root);
    const readObject = gitObjectReader(common);
    let head: string | undefined;
    try {
      head = fs.readFileSync(resolveInside(common, 'refs/heads/main'), 'utf8').trim();
    } catch {
      const refs = fs.readFileSync(resolveInside(common, 'packed-refs'), 'utf8');
      head = refs
        .split(/\r?\n/)
        .find((line) => line.endsWith(' refs/heads/main'))
        ?.split(' ')[0];
    }
    const pending = head ? [head] : [];
    while (pending.length) {
      const sha = pending.pop()!;
      if (!/^[a-f0-9]{40}$/i.test(sha) || ancestors.has(sha)) continue;
      ancestors.add(sha);
      try {
        const header = readObject(sha).toString('utf8').split('\n\n')[0];
        for (const line of header.split('\n')) {
          if (/^parent [a-f0-9]{40}$/i.test(line)) pending.push(line.slice(7));
        }
      } catch {
        // Unavailable history: only the refs/objects actually read are evidence.
      }
    }
  } catch {
    // Git evidence is optional; the WorkStore projection remains readable.
  }
  return ancestors;
}

export function workStoreFile(root: string): string {
  const commonDir = gitCommonDir(root);
  const filename = resolveInside(commonDir, 'softwareagents/work.sqlite3');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    resolveInside(commonDir, `softwareagents/work.sqlite3${suffix}`);
  }
  return filename;
}

export function openReadOnlyWorkStore(root: string): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(workStoreFile(root), { readOnly: true });
    db.exec('PRAGMA busy_timeout = 1000');
    let version: unknown;
    try {
      version = db.prepare('SELECT version FROM schema_version WHERE singleton = 1').get()?.version;
    } catch {
      throw new FeaturesReadFailure('schema_incompatible');
    }
    // Migration 15 introduced the display fields. Later additive migrations stay readable;
    // schemas beyond the migration list are unknown and rejected.
    if (
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version < MIN_PANEL_SCHEMA_VERSION ||
      version > latestSchemaVersion()
    ) {
      throw new FeaturesReadFailure('schema_incompatible');
    }
    return db;
  } catch (error) {
    db?.close();
    throw error instanceof FeaturesReadFailure ? error : new FeaturesReadFailure('unavailable');
  }
}
