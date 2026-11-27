import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runProjectTests } from '../src/commands/projectTests.js';
import { detectTestProfile } from '../src/projectTestProfile.js';

let root: string;
const write = (file: string, content: unknown) =>
  fs.writeFileSync(
    path.join(root, file),
    typeof content === 'string' ? content : JSON.stringify(content),
  );

describe('SA-163 project test profile', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-test-profile-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('a web app gets unit, browser e2e and design layers, reusing its runner', () => {
    write('package.json', { dependencies: { react: '1' }, devDependencies: { vitest: '1' } });
    expect(detectTestProfile(root)).toEqual({
      kind: 'web',
      layers: ['unit', 'e2e', 'design'],
      unit: 'vitest',
      e2e: 'playwright',
      missing: ['@playwright/test'],
    });
  });

  it('asks for nothing a web app already has', () => {
    write('package.json', { devDependencies: { jest: '1', '@playwright/test': '1', vite: '1' } });
    expect(detectTestProfile(root)).toMatchObject({ unit: 'jest', missing: [] });
  });

  it('a Node CLI gets unit and contract tests with no browser and no new dependency', () => {
    write('package.json', { bin: { tool: 'cli.js' } });
    expect(detectTestProfile(root)).toEqual({
      kind: 'cli',
      layers: ['unit', 'contract'],
      unit: 'node-test',
      e2e: null,
      missing: [],
    });
  });

  it('a CLI built with React stays a CLI; vite without a page is not a web app', () => {
    write('package.json', { bin: 'cli.js', dependencies: { react: '1', ink: '1' } });
    expect(detectTestProfile(root)).toMatchObject({ kind: 'cli', e2e: null, missing: [] });
    write('package.json', { devDependencies: { vite: '1' } });
    expect(detectTestProfile(root)?.kind).toBe('library');
    write('index.html', '<!doctype html>');
    expect(detectTestProfile(root)?.kind).toBe('web');
  });

  it('a workspace root reuses the runners its members already have', () => {
    write('package.json', { workspaces: ['packages/*', 'app'] });
    fs.mkdirSync(path.join(root, 'packages', 'ui'), { recursive: true });
    fs.mkdirSync(path.join(root, 'app'));
    write('packages/ui/package.json', {
      dependencies: { react: '1' },
      devDependencies: { vitest: '1' },
    });
    write('app/package.json', { devDependencies: { '@playwright/test': '1' } });
    expect(detectTestProfile(root)).toMatchObject({ kind: 'web', unit: 'vitest', missing: [] });
  });

  it('recognises an API and a plain library', () => {
    write('package.json', { dependencies: { fastify: '1' } });
    expect(detectTestProfile(root)?.kind).toBe('api');
    write('package.json', {});
    expect(detectTestProfile(root)?.kind).toBe('library');
  });

  it('a Python API asks for pytest only when it is not there yet', () => {
    write('requirements.txt', 'fastapi\n');
    expect(detectTestProfile(root)).toMatchObject({
      kind: 'api',
      unit: 'pytest',
      missing: ['pytest'],
    });
    write('requirements.txt', 'fastapi\npytest\n');
    expect(detectTestProfile(root)?.missing).toEqual([]);
  });

  it('Rust and Go use their built-in runners', () => {
    write('Cargo.toml', '[package]\nname = "x"\n');
    fs.mkdirSync(path.join(root, 'src'));
    write('src/main.rs', 'fn main() {}');
    expect(detectTestProfile(root)).toMatchObject({ kind: 'cli', unit: 'cargo' });
    fs.rmSync(path.join(root, 'Cargo.toml'));
    write('go.mod', 'module x\n');
    expect(detectTestProfile(root)).toMatchObject({ kind: 'library', unit: 'go' });
  });

  it('returns null for an unknown stack or an unreadable manifest', () => {
    expect(detectTestProfile(root)).toBeNull();
    write('package.json', '{ not json');
    expect(detectTestProfile(root)).toBeNull();
  });

  it('project tests explains the profile in Spanish without installing anything', () => {
    write('package.json', { dependencies: { react: '1' } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      runProjectTests(['tests']);
      expect(log.mock.calls.map(([line]) => line)).toEqual([
        'Proyecto: aplicación web.',
        'Tests que se exigen por cada criterio: unitarios, e2e en navegador real con capturas, barrido de diseño y accesibilidad.',
        'Herramientas: el ejecutor de tests incluido en Node.js, Playwright.',
        'Falta instalar, con tu aprobación: @playwright/test. Los agentes no instalan dependencias.',
      ]);
    } finally {
      log.mockRestore();
      cwd.mockRestore();
    }
  });
});
