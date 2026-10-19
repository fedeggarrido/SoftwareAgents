import * as fs from 'fs';

import { taskPath } from './commands/taskFiles.js';
import { DEFAULT_PROTECTED_PATHS, matchesProtectedPath } from './executors/protectedPaths.js';

/** Match the same zone language, including zero directories for an interior globstar. */
export function matchesChangeZone(file: string, zone: string, directory = false): boolean {
  const parts = zone.replace(/\/$/, '').split('/');
  const segments = file.split('/');
  const match = (i: number, j: number): boolean => {
    if (i === parts.length) return j === segments.length || (directory && j < segments.length);
    if (parts[i] === '**') return match(i + 1, j) || (j < segments.length && match(i, j + 1));
    const expression = parts[i]
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*');
    return (
      j < segments.length &&
      new RegExp(`^${expression}$`, 'i').test(segments[j]) &&
      match(i + 1, j + 1)
    );
  };
  return match(0, 0);
}

/** Validate declared paths, leaving possible protected descendants to per-file guards. */
export function validateChangeZone(
  cwd: string,
  zone: string,
  protectedPaths: readonly string[],
): void {
  const parts = zone.replace(/\/$/, '').split('/');
  const firstGlob = parts.findIndex((part) => part.includes('*'));
  const prefix = (firstGlob < 0 ? parts : parts.slice(0, firstGlob)).join('/');
  const fixedParts = firstGlob < 0 ? parts : parts.slice(0, firstGlob);
  const fixedPrefixes = fixedParts.map((_, i) => fixedParts.slice(0, i + 1).join('/'));
  // Literal runs after a glob still explicitly name protected segments, e.g.
  // src/**/.codex/*. A wildcard alone must not invent a protected descendant.
  const namedPrefixes: string[] = [];
  let literalRun: string[] = [];
  for (const part of parts) {
    if (part.includes('*')) literalRun = [];
    else {
      literalRun.push(part);
      namedPrefixes.push(literalRun.join('/'));
    }
  }
  const protectedZones = [
    '.git/**',
    '**/.git/**',
    '.softwareagents/**',
    ...DEFAULT_PROTECTED_PATHS,
    ...protectedPaths,
  ];
  const protectedZone = protectedZones.find((pattern) =>
    (pattern.startsWith('**/') ? namedPrefixes : fixedPrefixes).some((candidate) =>
      matchesProtectedPath(candidate, pattern.replace(/\/$/, '/**')),
    ),
  );
  if (protectedZone) throw new Error(`changeZones ${zone} covers protected path ${protectedZone}`);
  if (prefix) {
    const target = taskPath(cwd, prefix);
    if (fs.existsSync(target) && firstGlob >= 0 && !fs.statSync(target).isDirectory())
      throw new Error('changeZones glob prefix must be a directory');
  }
}
