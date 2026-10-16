import * as fs from 'fs';
import * as path from 'path';

import { TASK_CLI_COPY_BUFFER_BYTES, TASK_CLI_INPUT_BYTES } from '../constants.js';
import { resolveInside } from '../pathGuard.js';

/** Containment plus no links in any existing descendant component (including junctions). */
export function taskPath(root: string, relative: string): string {
  const target = resolveInside(root, relative);
  let current = path.resolve(root);
  for (const part of relative.split(/[\\/]/).filter((part) => part && part !== '.')) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error(`Links are forbidden: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}

export function taskDirectory(root: string, relative: string): string {
  const target = taskPath(root, relative);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  taskPath(root, relative);
  return target;
}

function openRegular(file: string): number {
  if (!fs.lstatSync(file).isFile()) throw new Error(`Expected a regular file: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  if (!fs.fstatSync(fd).isFile()) {
    fs.closeSync(fd);
    throw new Error(`Expected a regular file: ${file}`);
  }
  return fd;
}

export function readTaskInput(root: string, relative: string): string {
  const fd = openRegular(taskPath(root, relative));
  try {
    if (fs.fstatSync(fd).size > TASK_CLI_INPUT_BYTES) throw new Error('Input exceeds 1 MiB limit');
    const buffer = Buffer.alloc(TASK_CLI_INPUT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > TASK_CLI_INPUT_BYTES) throw new Error('Input exceeds 1 MiB limit');
    return buffer.toString('utf8', 0, size);
  } finally {
    fs.closeSync(fd);
  }
}

/** Fixed-memory copy through verified descriptors, exclusive destination, durable contents. */
export function copyTaskFile(source: string, destination: string): void {
  const input = openRegular(source);
  try {
    const output = fs.openSync(destination, 'wx', 0o600);
    try {
      const buffer = Buffer.alloc(TASK_CLI_COPY_BUFFER_BYTES);
      let count: number;
      while ((count = fs.readSync(input, buffer, 0, buffer.length, null))) {
        let written = 0;
        while (written < count) written += fs.writeSync(output, buffer, written, count - written);
      }
      fs.fsyncSync(output);
    } finally {
      fs.closeSync(output);
    }
  } finally {
    fs.closeSync(input);
  }
}
