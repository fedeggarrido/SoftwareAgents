import * as path from 'path';

/** Lexical containment only; symlink and junction hardening belongs to SA-060. */
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
  const resolved = path.resolve(root, ...rel.split(/[\\/]/));
  const relative = path.relative(path.resolve(root), resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Path must stay inside its root');
  }
  return resolved;
}
