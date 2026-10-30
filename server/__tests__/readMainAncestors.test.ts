import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { readMainAncestors } from '../src/workstore/readOnlyWorkStore.js';

let root: string;
const git = (...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  ).trim();

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('readMainAncestors', () => {
  it('sees commits that git maintenance packed into loose-<hash>.pack', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-ancestors-'));
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'first');
    const first = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'b.txt'), 'b');
    git('add', 'b.txt');
    git('commit', '-q', '-m', 'second');
    const second = git('rev-parse', 'HEAD');
    git('maintenance', 'run', '--task=loose-objects');
    git('prune-packed');
    const packDir = path.join(root, '.git', 'objects', 'pack');
    expect(fs.readdirSync(packDir).some((name) => /^loose-.*\.idx$/.test(name))).toBe(true);
    const ancestors = readMainAncestors(root);
    expect(ancestors.has(second)).toBe(true);
    expect(ancestors.has(first)).toBe(true);
  });
});
