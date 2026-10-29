import * as fs from 'fs';
import * as path from 'path';

import { matchesChangeZone } from './changeZones.js';

const playwrightDefaults = ['spec', 'test'].flatMap((kind) =>
  ['', 'c', 'm'].flatMap((module) =>
    ['js', 'jsx', 'ts', 'tsx'].map((ext) => `**/*.${kind}.${module}${ext}`),
  ),
);

const defaults = {
  server: ['server/__tests__/**/*.test.ts'],
  webview: ['webview-ui/test/*.test.ts'],
  playwright: playwrightDefaults.map((glob) => 'e2e/tests/' + glob),
};

/** Deliberately bounded static grammar. Unsupported expressions use an explicit fallback,
 * surfaced to callers and checked against the real repository by testRoots.test.ts. */
function strings(value: string): string[] {
  if (/^\[\s*\]$/.test(value)) return [];
  const literals = [...value.matchAll(/(['"])([^'"\r\n\\]*)\1/g)];
  if (!literals.length || value.replace(/(['"])([^'"\r\n\\]*)\1/g, '').replace(/[\s,[\]]/g, ''))
    throw new Error('Expected literal string or string array');
  return literals.map((match) => match[2]);
}

export function testDiscovery(repo: string) {
  const fallback: string[] = [];
  const read = (
    name: keyof typeof defaults,
    config: string,
    parse: (source: string) => string[],
  ) => {
    try {
      // Remove comments without treating // inside quoted glob patterns as comments.
      const source = fs
        .readFileSync(path.join(repo, config), 'utf8')
        .replace(/(['"])(?:\\.|(?!\1)[^\\])*?\1|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (token) =>
          token.startsWith('/') ? '' : token,
        );
      const patterns = parse(source);
      if (patterns.some((glob) => /[?!{}[\]\\]/.test(glob) || glob.split('/').includes('..')))
        throw new Error('Unsupported discovery glob');
      return patterns;
    } catch {
      fallback.push(config);
      return [...defaults[name]];
    }
  };
  const includes = (prefix: string) => (source: string) => {
    const value = /\binclude\s*:\s*(\[[^\]]*\])\s*[,}]/.exec(source)?.[1];
    if (!value) throw new Error('Missing literal include');
    return strings(value).map((glob) => prefix + glob);
  };
  const server = read('server', 'server/vitest.config.ts', includes('server/'));
  const webview = read('webview', 'webview-ui/vitest.config.ts', includes('webview-ui/'));
  const playwright = read('playwright', 'e2e/playwright.config.ts', (source) => {
    const dir =
      /\btestDir\s*:\s*path\.join\(\s*__dirname\s*,\s*(['"])([^'"]+)\1\s*\)\s*[,}]/.exec(
        source,
      )?.[2] ?? /\btestDir\s*:\s*(['"])([^'"]+)\1\s*[,}]/.exec(source)?.[2];
    if (!dir) throw new Error('Unsupported testDir');
    const match = /\btestMatch\s*:\s*(\[[^\]]*\]|'[^']*'|"[^"]*")\s*[,}]/.exec(source)?.[1];
    if (/\btestMatch\s*:/.test(source) && !match) throw new Error('Unsupported testMatch');
    // Playwright default **/*(spec|test).?(c|m)[jt]s?(x), expanded to simple globs.
    const globs = match ? strings(match) : playwrightDefaults;
    return globs.map((glob) => path.posix.join('e2e', dir, glob));
  });
  const patterns = [...server, ...webview, ...playwright];
  const roots = [
    ...new Set(
      patterns.map((glob) =>
        glob.slice(0, glob.includes('*') ? glob.indexOf('*') : glob.length).replace(/[^/]*$/, ''),
      ),
    ),
  ];
  return { server, webview, playwright, patterns, roots, fallback };
}

export function isExecutedTest(file: string, repo: string): boolean {
  return testDiscovery(repo).patterns.some((pattern) =>
    matchesChangeZone(file, pattern, false, true),
  );
}

/** Mirror uses the configured webview include, including its suffix and flat directory. */
export function webviewTestMirrors(file: string, repo: string): string[] {
  if (!file.startsWith('webview-ui/src/') || !/\.[cm]?[jt]sx?$/i.test(file) || file.includes('*'))
    return [];
  const basename = path.posix.basename(file).replace(/\.[^.]+$/, '');
  return testDiscovery(repo).webview.map((pattern) =>
    pattern.replace(/\*([^/]*)$/, `${basename}*$1`),
  );
}

export function serverTestMirrors(zone: string, repo: string, directory: boolean): string[] {
  const sourceRoot = zone.startsWith('core/src/') ? 'core/src/' : 'server/src/';
  if (!zone.startsWith(sourceRoot)) return [];
  const relative = (sourceRoot === 'core/src/' ? 'core/' : '') + zone.slice(sourceRoot.length);
  return testDiscovery(repo).server.flatMap((pattern) => {
    if (!pattern.includes('*')) return [];
    const root = pattern.slice(0, pattern.indexOf('*'));
    if (directory) return [root + relative.replace(/\/$/, '') + '/'];
    const suffix = /\*([^/*]+)$/.exec(pattern)?.[1];
    if (!suffix || !/\.[cm]?[jt]sx?$/i.test(relative)) return [];
    return [root + relative.replace(/\.[^.]+$/, '').replace(/\*+$/, '') + '*' + suffix];
  });
}
