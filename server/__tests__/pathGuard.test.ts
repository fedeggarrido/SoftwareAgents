import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveInside } from '../src/pathGuard.js';

describe('resolveInside canonical containment', () => {
  let temp: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'path-guard-'));
    root = path.join(temp, 'root');
    outside = path.join(temp, 'root-sibling');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'file.txt'), 'inside');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it('resolves a directory created between realpath and lstat', () => {
    const directory = path.join(root, 'concurrent');
    const realpath = fs.realpathSync.native;
    let created = false;
    vi.spyOn(fs.realpathSync, 'native').mockImplementation((candidate, options) => {
      if (candidate === directory && !created) {
        created = true;
        fs.mkdirSync(directory);
        throw Object.assign(new Error('not found before concurrent mkdir'), { code: 'ENOENT' });
      }
      return realpath(candidate, options);
    });
    expect(resolveInside(root, 'concurrent')).toBe(realpath(directory));
    expect(created).toBe(true);
  });

  it.each(['nested/file.txt', 'nested\\file.txt', './nested/file.txt'])('accepts %s', (rel) => {
    expect(resolveInside(root, rel)).toBe(
      fs.realpathSync.native(path.join(root, 'nested', 'file.txt')),
    );
  });

  it('resolves a missing suffix without creating it', () => {
    expect(resolveInside(root, 'nested/new/deep/file.txt')).toBe(
      path.join(fs.realpathSync.native(root), 'nested', 'new', 'deep', 'file.txt'),
    );
    expect(fs.existsSync(path.join(root, 'nested', 'new'))).toBe(false);
  });

  it.each([
    '',
    '.',
    '..',
    '../root/file',
    'nested/../file',
    'nested\\..\\file',
    'nested/..\\file',
    '/outside',
    'C:\\outside',
    'c:outside',
    '\\\\host\\share\\file',
    '\\\\?\\C:\\outside',
    '\\\\?\\UNC\\host\\share\\file',
    'bad\0file',
  ])('rejects %j', (rel) => {
    expect(() => resolveInside(root, rel)).toThrow();
  });

  it('rejects absolute inputs even inside the root', () => {
    expect(() => resolveInside(root, outside)).toThrow();
    expect(() => resolveInside(root, path.join(root, 'nested'))).toThrow();
  });

  it('requires an existing directory root and directory ancestors', () => {
    expect(() => resolveInside(path.join(root, 'missing'), 'file')).toThrow();
    expect(() => resolveInside(path.join(root, 'nested', 'file.txt'), 'file')).toThrow();
    expect(() => resolveInside(root, 'nested/file.txt/child')).toThrow();
  });

  for (const type of ['dir', 'junction'] as const) {
    it.skipIf(type === 'junction' && process.platform !== 'win32')(
      `checks real ${type} links`,
      (ctx) => {
        const escape = path.join(root, 'escape');
        try {
          fs.symlinkSync(outside, escape, type);
        } catch (error) {
          if (
            ['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')
          ) {
            ctx.skip();
            return;
          }
          throw error;
        }
        fs.writeFileSync(path.join(outside, 'existing'), 'outside');
        expect(() => resolveInside(root, 'escape')).toThrow();
        expect(() => resolveInside(root, 'escape/existing')).toThrow();
        expect(() => resolveInside(root, 'escape/missing/deep')).toThrow();
        fs.symlinkSync(path.join(root, 'nested'), path.join(root, 'inside'), type);
        expect(resolveInside(root, 'inside/file.txt')).toBe(
          fs.realpathSync.native(path.join(root, 'nested', 'file.txt')),
        );
        expect(resolveInside(root, 'inside/new/deep')).toBe(
          path.join(fs.realpathSync.native(root), 'nested', 'new', 'deep'),
        );
        fs.symlinkSync(root, path.join(temp, 'alias'), type);
        expect(resolveInside(path.join(temp, 'alias'), 'nested/file.txt')).toBe(
          resolveInside(root, 'nested/file.txt'),
        );
        fs.symlinkSync(path.join(outside, 'absent'), path.join(root, 'dangling'), type);
        expect(() => resolveInside(root, 'dangling/child')).toThrow();
      },
    );
  }

  describe.skipIf(process.platform !== 'win32')('Windows native paths', () => {
    it('accepts root drive casing, directory casing, mixed separators and extended prefixes', () => {
      const expected = resolveInside(root, 'nested/file.txt');
      expect(resolveInside(root.toUpperCase(), 'NESTED/file.txt')).toBe(expected);
      expect(
        resolveInside(
          root.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()),
          'nested\\file.txt',
        ),
      ).toBe(expected);
      expect(resolveInside(path.toNamespacedPath(root), 'nested/file.txt')).toBe(expected);
      expect(resolveInside(root.replaceAll('\\', '/'), 'nested\\file.txt')).toBe(expected);
    });

    it.each([
      '.. /file',
      'nested./file',
      'nested /file',
      'nested/file:stream',
      'NUL',
      'con.txt',
      'nested/COM1',
    ])('rejects ambiguous Windows input %s', (rel) => {
      expect(() => resolveInside(root, rel)).toThrow();
    });
  });
});
