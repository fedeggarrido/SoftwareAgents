import * as fs from 'fs';
import * as path from 'path';

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Path must stay inside its root');
  }
}

/** Resolve missing suffixes against the nearest existing ancestor; never hide broken links. */
function canonicalPath(candidate: string): string {
  const suffix: string[] = [];
  let ancestor = candidate;
  for (;;) {
    try {
      const real = fs.realpathSync.native(ancestor);
      if (suffix.length && !fs.statSync(real).isDirectory()) {
        throw new Error('Path parent must be a directory');
      }
      return path.join(real, ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling link exists according to lstat and must fail closed.
      try {
        fs.lstatSync(ancestor);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        suffix.unshift(path.basename(ancestor));
        ancestor = parent;
        continue;
      }
      throw error;
    }
  }
}
/**
 * Return a canonical descendant, resolving links even when the final path does not exist.
 * Absolute inputs remain forbidden for compatibility. The root may itself be a link.
 * This checks the current filesystem state; callers must prevent link replacement between
 * validation and use when an untrusted process can mutate the directory tree.
 */
export function resolveInside(root: string, rel: string): string {
  if (
    typeof rel !== 'string' ||
    !rel ||
    rel.includes('\0') ||
    path.posix.isAbsolute(rel) ||
    path.win32.isAbsolute(rel) ||
    /^[a-z]:/i.test(rel) ||
    rel.split(/[\\/]/).includes('..')
  ) {
    throw new Error('Expected a relative path without parent segments');
  }
  if (
    process.platform === 'win32' &&
    rel
      .split(/[\\/]/)
      .some(
        (part) =>
          part !== '.' &&
          (/[ .]$/.test(part) ||
            /[:<>"|?*]/.test(part) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
      )
  ) {
    throw new Error('Expected an unambiguous Windows path');
  }
  const resolved = path.resolve(root, ...rel.split(/[\\/]/));
  assertInside(path.resolve(root), resolved);
  const realRoot = fs.realpathSync.native(root);
  if (!fs.statSync(realRoot).isDirectory()) throw new Error('Root must be a directory');
  const canonical = canonicalPath(resolved);
  assertInside(realRoot, canonical);
  return canonical;
}
