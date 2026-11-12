import * as fs from 'node:fs';
import * as path from 'node:path';

import type { NewProjectError } from '../../core/src/messages.js';
import { taskPath } from './commands/taskFiles.js';
import { NEW_PROJECT_MIN_FREE_BYTES } from './constants.js';

export class NewProjectFailure extends Error {
  constructor(readonly code: NewProjectError) {
    super(code);
  }
}

export function failNewProject(code: NewProjectError): never {
  throw new NewProjectFailure(code);
}

export function optionalEntry(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Absolute local paths only. Every existing component is checked without following links. */
export function projectDirectory(input: string): string {
  if (
    !path.isAbsolute(input) ||
    (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(input)) ||
    /^[\\/]{2}/.test(input) ||
    /[\u0000-\u001f]/.test(input) ||
    input
      .split(/[\\/]/)
      .some((part) => part === '..' || part === '.' || part.toLowerCase() === '.git')
  )
    return failNewProject('unsafe_path');
  const resolved = path.resolve(input);
  const root = path.parse(resolved).root;
  try {
    return resolved === root ? root : taskPath(root, path.relative(root, resolved));
  } catch {
    return failNewProject('unsafe_path');
  }
}

export function requireProjectDirectory(input: string): string {
  const directory = projectDirectory(input);
  if (!optionalEntry(directory)?.isDirectory()) return failNewProject('not_directory');
  return directory;
}

export function checkProjectCapacity(directory: string): void {
  try {
    fs.accessSync(directory, fs.constants.W_OK);
  } catch {
    return failNewProject('unwritable');
  }
  try {
    const stat = fs.statfsSync(directory, { bigint: true });
    if (stat.bavail * stat.bsize < BigInt(NEW_PROJECT_MIN_FREE_BYTES))
      return failNewProject('no_space');
  } catch (error) {
    if (error instanceof NewProjectFailure) throw error;
    return failNewProject('unavailable');
  }
}
