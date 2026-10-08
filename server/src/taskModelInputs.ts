import * as fs from 'fs';

import type { WorkSize, WorkType } from '../../core/src/modelTier.js';
import type { ProjectConfig } from '../../core/src/project.js';
import { type TierInputs, WORK_TYPES } from './modelTiers.js';
import { resolveInside } from './pathGuard.js';
import type { TaskRecord } from './workstore/WorkStore.js';

/** WorkStore type + explicitly bound board size. Brief text cannot select argv.
 * SA-020 compiles context/roles, not task estimates; unavailable fields stay absent. */
export function taskModelInputs(
  config: ProjectConfig,
  task: TaskRecord | undefined,
  key: string,
): TierInputs {
  const workType =
    task && (WORK_TYPES as readonly string[]).includes(task.type)
      ? (task.type as WorkType)
      : undefined;
  let size: WorkSize | undefined;
  const board = config.project.legacy?.boardFile;
  if (board) {
    try {
      const raw: unknown = JSON.parse(
        fs.readFileSync(resolveInside(config.repoRoot, board), 'utf8'),
      );
      const items = (raw as { items?: { id?: unknown; size?: unknown }[] })?.items;
      if (Array.isArray(items)) {
        const matches = items.filter((i) => i?.id === key);
        if (
          matches.length === 1 &&
          typeof matches[0].size === 'string' &&
          ['S', 'M', 'L'].includes(matches[0].size)
        )
          size = matches[0].size as WorkSize;
      }
    } catch {
      /* Missing/unreadable estimates use the documented capability fallback. */
    }
  }
  return { ...(workType ? { workType } : {}), ...(size ? { size } : {}) };
}
