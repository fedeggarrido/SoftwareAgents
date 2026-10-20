import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveInside } from './pathGuard.js';

/** Operator-only profile, physically contained in the user's home; never create it. */
export function claudeConfigEnvironment(configDir?: string): NodeJS.ProcessEnv | undefined {
  if (configDir === undefined) return undefined;
  try {
    if (!path.isAbsolute(configDir)) throw new Error('absolute path required');
    const directory = resolveInside(os.homedir(), path.relative(os.homedir(), configDir));
    if (!fs.statSync(directory).isDirectory()) throw new Error('directory required');
    return { CLAUDE_CONFIG_DIR: directory };
  } catch {
    throw new Error(
      'Invalid Operator executors.claude.configDir: expected an existing absolute directory inside the user profile',
    );
  }
}
