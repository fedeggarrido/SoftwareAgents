import * as fs from 'fs';

import { taskPath } from './commands/taskFiles.js';
import { DEFAULT_PROTECTED_PATHS } from './executors/protectedPaths.js';

type Edge = { to: number; char?: string; wildcard?: 'segment' | 'any' };

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

/** Same simple glob language as SA-063; globstar may match zero directories. */
function automaton(pattern: string, descendants = false): Edge[][] {
  const states: Edge[][] = [[]];
  let current = 0;
  const directoryStates: number[] = [];
  const next = () => states.push([]) - 1;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.slice(i) === '/**') directoryStates.push(current);
    const end = next();
    if (pattern.startsWith('**/', i)) {
      const loop = next();
      states[current].push({ to: end }, { to: loop, wildcard: 'any' });
      states[loop].push({ to: loop, wildcard: 'any' }, { to: end, char: '/' });
      i += 2;
    } else if (pattern[i] === '*') {
      const double = pattern[i + 1] === '*';
      states[current].push({ to: end }, { to: current, wildcard: double ? 'any' : 'segment' });
      if (double) i++;
    } else {
      states[current].push({ to: end, char: pattern[i].toLowerCase() });
    }
    current = end;
  }
  // A zone naming a directory covers its descendants. Protected directory patterns
  // also cover the directory itself (it could otherwise be replaced by a link).
  const end = next();
  const loop = next();
  states[current].push({ to: end });
  if (descendants) {
    states[current].push({ to: loop, char: '/' });
    states[loop].push({ to: end }, { to: loop, wildcard: 'any' });
  }
  for (const directory of directoryStates) states[directory].push({ to: end });
  return states;
}

function overlaps(left: string, right: string, descendants: boolean): boolean {
  const a = automaton(left.replace(/\/$/, ''), descendants);
  const b = automaton(right.replace(/\/$/, ''));
  const pending = [[0, 0]];
  const seen = new Set<string>();
  while (pending.length) {
    const [x, y] = pending.pop()!;
    const key = `${x}:${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The final two states are accept and the descendant loop.
    if (x === a.length - 2 && y === b.length - 2) return true;
    const epsilon = (edge: Edge) => edge.char === undefined && !edge.wildcard;
    for (const edge of a[x]) if (epsilon(edge)) pending.push([edge.to, y]);
    for (const edge of b[y]) if (epsilon(edge)) pending.push([x, edge.to]);
    for (const l of a[x])
      for (const r of b[y]) {
        if (epsilon(l) || epsilon(r)) continue;
        if (
          (l.char !== undefined && r.char !== undefined && l.char === r.char) ||
          (l.wildcard && r.wildcard) ||
          (l.char !== undefined && r.wildcard && (r.wildcard === 'any' || l.char !== '/')) ||
          (r.char !== undefined && l.wildcard && (l.wildcard === 'any' || r.char !== '/'))
        )
          pending.push([l.to, r.to]);
      }
  }
  return false;
}

/** Validate the fixed directory prefix physically, then intersect with protected globs. */
export function validateChangeZone(
  cwd: string,
  zone: string,
  protectedPaths: readonly string[],
): void {
  const parts = zone.replace(/\/$/, '').split('/');
  const firstGlob = parts.findIndex((part) => part.includes('*'));
  const prefix = (firstGlob < 0 ? parts : parts.slice(0, firstGlob)).join('/');
  const protectedZones = [
    '.git/**',
    '.softwareagents/**',
    ...DEFAULT_PROTECTED_PATHS,
    ...protectedPaths,
  ];
  const checkProtected = (descendants: boolean) => {
    const protectedZone = protectedZones.find((pattern) => overlaps(zone, pattern, descendants));
    if (protectedZone)
      throw new Error(`changeZones ${zone} covers protected path ${protectedZone}`);
  };
  checkProtected(zone.endsWith('/'));
  if (prefix) {
    const target = taskPath(cwd, prefix);
    if (fs.existsSync(target)) {
      const directory = fs.statSync(target).isDirectory();
      if (firstGlob >= 0 && !directory)
        throw new Error('changeZones glob prefix must be a directory');
      if (firstGlob < 0 && directory) checkProtected(true);
    }
  }
}
