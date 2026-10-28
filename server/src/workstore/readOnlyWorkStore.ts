import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { FeaturesReadError } from '../../../core/src/messages.js';
import { resolveInside } from '../pathGuard.js';

export class FeaturesReadFailure extends Error {
  constructor(readonly reason: FeaturesReadError) {
    super(reason);
  }
}

/** Resolve Git metadata using files only, including linked worktrees. */
export function openReadOnlyWorkStore(root: string): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    const marker = path.join(fs.realpathSync.native(root), '.git');
    let gitDir = marker;
    if (!fs.statSync(marker).isDirectory()) {
      const match = /^gitdir: (.+)\s*$/.exec(fs.readFileSync(marker, 'utf8').trim());
      if (!match) throw new Error('Invalid gitdir');
      gitDir = path.resolve(root, match[1]);
    }
    gitDir = fs.realpathSync.native(gitDir);
    const commonFile = path.join(gitDir, 'commondir');
    const commonDir = fs.existsSync(commonFile)
      ? fs.realpathSync.native(path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim()))
      : gitDir;
    const filename = resolveInside(commonDir, 'softwareagents/work.sqlite3');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      resolveInside(commonDir, `softwareagents/work.sqlite3${suffix}`);
    }
    db = new DatabaseSync(filename, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 1000');
    let version: unknown;
    try {
      version = db.prepare('SELECT version FROM schema_version WHERE singleton = 1').get()?.version;
    } catch {
      throw new FeaturesReadFailure('schema_incompatible');
    }
    // Migration 15 introduced the display fields. Reject unknown future schemas.
    if (version !== 15) throw new FeaturesReadFailure('schema_incompatible');
    return db;
  } catch (error) {
    db?.close();
    throw error instanceof FeaturesReadFailure ? error : new FeaturesReadFailure('unavailable');
  }
}
