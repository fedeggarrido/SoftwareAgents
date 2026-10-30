import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, expect, it } from 'vitest';

import { checkZones, runZonesCommand } from '../src/zonesCheck.js';

let root: string;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
it('compares real unmerged branches, checks declarations, and ignores merged refs', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'zones-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false', ...args], {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: path.join(root, 'absent'),
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    }).trim();
  git('init', '-b', 'main');
  fs.writeFileSync(path.join(root, 'shared.ts'), 'base');
  git('add', '.');
  git('commit', '-m', 'base');
  git('checkout', '-b', 'sa/one');
  fs.writeFileSync(path.join(root, 'shared.ts'), 'one');
  git('add', '.');
  git('commit', '-m', 'one');
  git('checkout', 'main');
  git('checkout', '-b', 'sa/two');
  fs.writeFileSync(path.join(root, 'other.ts'), 'two');
  git('add', '.');
  git('commit', '-m', 'two');
  expect((await checkZones(root)).overlaps).toEqual([]);
  fs.writeFileSync(path.join(root, 'shared.ts'), 'two');
  git('add', '.');
  git('commit', '-m', 'shared');
  const report = await checkZones(root, [
    { key: 'two', branch: 'sa/two', declaration: JSON.stringify({ changeZones: ['other.ts'] }) },
  ]);
  expect(report.overlaps).toEqual([{ file: 'shared.ts', branches: ['sa/one', 'sa/two'] }]);
  let output = '';
  await runZonesCommand(['check', '--json'], root, (line) => {
    output = line;
  });
  expect(JSON.parse(output).overlaps).toEqual(report.overlaps);
  expect(report.branches.find((branch) => branch.branch === 'sa/two')?.outsideZones).toEqual([
    'shared.ts',
  ]);
  git('branch', 'sa/merged', 'main');
  expect((await checkZones(root)).branches.map((branch) => branch.branch)).not.toContain(
    'sa/merged',
  );
});
