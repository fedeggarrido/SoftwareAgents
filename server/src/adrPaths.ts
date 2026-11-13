import * as fs from 'node:fs';
import * as path from 'node:path';

import { taskPath } from './commands/taskFiles.js';
import type { WorkStore } from './workstore/WorkStore.js';

/** Shared project-wide numbering for Architect and Tech Lead, including failed attempts. */
export async function reserveAdrPaths(
  cwd: string,
  brain: string,
  reservation: string,
  titles: string[],
  store: WorkStore,
  purpose: 'architecture' | 'stack' = 'architecture',
): Promise<string[]> {
  const directory = taskPath(cwd, path.join(brain, 'adr'));
  const minimum = fs.existsSync(directory)
    ? Math.max(
        0,
        ...fs.readdirSync(directory).map((file) => Number(/^(\d{4})-/.exec(file)?.[1] ?? 0)),
      )
    : 0;
  const numbers = await store.reserveAdrNumbers(reservation, titles.length, minimum, purpose);
  return titles.map((title, index) => {
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || 'decision';
    return path.posix.join(
      brain.replaceAll('\\', '/'),
      'adr',
      `${String(numbers[index]).padStart(4, '0')}-${slug}.md`,
    );
  });
}
