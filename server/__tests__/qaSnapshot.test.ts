import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, expect, it, vi } from 'vitest';

import * as criteria from '../src/evalCriteria.js';
import { EvalIntegrityError } from '../src/evalIntegrity.js';
import { QaSnapshot } from '../src/qaSnapshot.js';

let root: string | undefined;
let session: QaSnapshot | undefined;
afterEach(() => {
  session?.dispose();
  const remove = (file: string) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) fs.unlinkSync(file);
    else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) remove(path.join(file, name));
      fs.rmdirSync(file);
    } else fs.unlinkSync(file);
  };
  if (root) remove(root);
  root = undefined;
  session = undefined;
  vi.restoreAllMocks();
});

it.each(['browser', 'changed-link', 'termination', 'nested-scratch', 'pinned-source'])(
  'preserves build and cleanup boundaries: %s',
  async (mode) => {
    const build = vi.spyOn(criteria, 'runVerifierCommand').mockResolvedValue('pass');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-snapshot-boundary-'));
    const source = path.join(root, 'source');
    const dependencies = path.join(root, 'dependencies');
    const scratch = path.join(mode === 'nested-scratch' ? source : root, 'scratch');
    for (const directory of [source, dependencies, scratch]) fs.mkdirSync(directory);
    fs.mkdirSync(path.join(source, 'webview-ui'));
    fs.writeFileSync(path.join(source, 'esbuild.js'), '// fake build');
    fs.writeFileSync(path.join(dependencies, 'sentinel'), 'keep');
    const signal = new AbortController().signal;
    session = new QaSnapshot(scratch, dependencies, mode === 'pinned-source');
    if (mode === 'termination') {
      build.mockRejectedValueOnce(new criteria.EvalCriterionTerminationError());
      await expect(session.prepare(source, false, signal, 10000)).rejects.toBeInstanceOf(
        criteria.EvalCriterionTerminationError,
      );
      session.dispose();
      expect(fs.readdirSync(scratch)).toHaveLength(1);
      await expect(session.prepare(source, false, signal, 10000)).rejects.toBeInstanceOf(
        EvalIntegrityError,
      );
    } else {
      const tree = await session.prepare(source, mode === 'browser', signal, 10000);
      if (mode === 'browser') {
        expect(await session.prepare(source, true, signal, 10000)).toBe(tree);
        expect(build).toHaveBeenCalledTimes(2); // one esbuild, one Vite
      } else if (mode === 'changed-link') {
        const link = path.join(tree, 'node_modules');
        fs.unlinkSync(link);
        fs.symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
        await expect(session.prepare(source, false, signal, 10000)).rejects.toBeInstanceOf(
          EvalIntegrityError,
        );
        session.dispose();
        expect(fs.existsSync(tree)).toBe(true);
      } else if (mode === 'pinned-source') {
        fs.writeFileSync(path.join(source, 'extra.ts'), 'mutation');
        await expect(session.prepare(source, false, signal, 10000)).rejects.toBeInstanceOf(
          EvalIntegrityError,
        );
      } else {
        expect(await session.prepare(source, false, signal, 10000)).toBe(tree);
      }
    }
    expect(fs.readFileSync(path.join(dependencies, 'sentinel'), 'utf8')).toBe('keep');
  },
);
it('reduces three identical command preparations from three copies/builds to one and invalidates changes', async () => {
  vi.spyOn(criteria, 'runVerifierCommand').mockResolvedValue('pass');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-snapshot-test-'));
  const source = path.join(root, 'source');
  const dependencies = path.join(root, 'dependencies');
  const scratch = path.join(root, 'scratch');
  for (const directory of [source, dependencies, scratch]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(source, 'esbuild.js'), '// fake build');
  fs.writeFileSync(path.join(source, 'input.ts'), 'original');
  const signal = new AbortController().signal;
  session = new QaSnapshot(scratch, dependencies);
  const first = await session.prepare(source, false, signal, 10000);
  expect(await session.prepare(source, false, signal, 10000)).toBe(first);
  expect(await session.prepare(source, false, signal, 10000)).toBe(first);
  expect(session.metrics).toMatchObject({ copies: 1, builds: 1, reuses: 2 });
  console.log('QA preparation for 3 commands: before copies=3 builds=3; after', session.metrics);
  fs.writeFileSync(path.join(first, 'input.ts'), 'test mutation');
  const clean = await session.prepare(source, false, signal, 10000);
  expect(fs.readFileSync(path.join(clean, 'input.ts'), 'utf8')).toBe('original');
  fs.writeFileSync(path.join(source, 'input.ts'), 'new source');
  expect(
    fs.readFileSync(
      path.join(await session.prepare(source, false, signal, 10000), 'input.ts'),
      'utf8',
    ),
  ).toBe('new source');
  const other = new QaSnapshot(scratch, dependencies);
  try {
    expect(await other.prepare(source, false, signal, 10000)).not.toBe(clean);
  } finally {
    other.dispose();
  }
  session.dispose();
  expect(fs.existsSync(dependencies)).toBe(true);
  expect(fs.readdirSync(scratch)).toEqual([]);
});
