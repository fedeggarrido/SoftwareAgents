import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { removeAgentToolCaches } from '../src/developer.js';

const roots: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-caches-'));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('removeAgentToolCaches', () => {
  it('removes a Vitest results cache the agent left in server/node_modules/.vite', () => {
    const tree = temp();
    const cache = path.join(tree, 'server/node_modules/.vite/vitest/abc');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'results.json'), '{}');
    removeAgentToolCaches(tree);
    expect(fs.existsSync(path.join(tree, 'server/node_modules'))).toBe(false);
  });

  it('removes allure-results and .vitest-tmp left by the agent running tests', () => {
    const tree = temp();
    fs.mkdirSync(path.join(tree, 'allure-results'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'allure-results', 'r.json'), '{}');
    fs.mkdirSync(path.join(tree, 'server/.vitest-tmp/x'), { recursive: true });
    removeAgentToolCaches(tree);
    expect(fs.existsSync(path.join(tree, 'allure-results'))).toBe(false);
    expect(fs.existsSync(path.join(tree, 'server/.vitest-tmp'))).toBe(false);
  });

  it('removes .vitest-tmp with junctions inside without touching their targets', () => {
    const tree = temp();
    const shared = temp();
    fs.writeFileSync(path.join(shared, 'keep.json'), '{}');
    fs.mkdirSync(path.join(tree, '.vitest-tmp/repo'), { recursive: true });
    fs.symlinkSync(
      shared,
      path.join(tree, '.vitest-tmp/repo/node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    removeAgentToolCaches(tree);
    expect(fs.existsSync(path.join(tree, '.vitest-tmp'))).toBe(false);
    expect(fs.existsSync(path.join(shared, 'keep.json'))).toBe(true);
  });

  it('never touches a linked (junction) node_modules or what it points to', () => {
    const tree = temp();
    const shared = temp();
    fs.mkdirSync(path.join(shared, '.vite'), { recursive: true });
    fs.writeFileSync(path.join(shared, '.vite', 'keep.json'), '{}');
    fs.mkdirSync(path.join(tree, 'server'));
    fs.symlinkSync(
      shared,
      path.join(tree, 'server/node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    removeAgentToolCaches(tree);
    expect(fs.existsSync(path.join(shared, '.vite', 'keep.json'))).toBe(true);
  });

  it('keeps other node_modules content and refuses a cache containing links', () => {
    const tree = temp();
    const outside = temp();
    fs.mkdirSync(path.join(tree, 'node_modules/.vite'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'node_modules/other.txt'), 'x');
    fs.symlinkSync(
      outside,
      path.join(tree, 'node_modules/.vite/link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => removeAgentToolCaches(tree)).toThrow(/links/);
    expect(fs.existsSync(path.join(tree, 'node_modules/other.txt'))).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
  });
});
