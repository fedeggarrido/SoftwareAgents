import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { developerScope } from '../src/developer.js';
import { vitestWorkspace } from '../src/evalCriteria.js';
import { reviewerBrief, type ReviewerRequest } from '../src/reviewer.js';
import { isExecutedTest, testDiscovery, webviewTestMirrors } from '../src/testRoots.js';

const repo = path.resolve(__dirname, '../..');

describe('configured test discovery', () => {
  it('reads literal changes and comments without executing configs, and exposes fallback', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'test-roots-'));
    try {
      for (const dir of ['server', 'webview-ui', 'e2e']) fs.mkdirSync(path.join(temporary, dir));
      fs.writeFileSync(
        path.join(temporary, 'server/vitest.config.ts'),
        "throw new Error('never execute'); export default { test: { /* include: ['wrong'] */ include: [ 'checks/**/*.test.ts', ], } };",
      );
      fs.writeFileSync(
        path.join(temporary, 'webview-ui/vitest.config.ts'),
        "export default { test: { include: ['checks/*.test.ts'], } }; // include: ['wrong']",
      );
      fs.writeFileSync(
        path.join(temporary, 'e2e/playwright.config.ts'),
        "export default { testDir: 'specs', testMatch: ['**/*.spec.ts'], };",
      );
      const discovery = testDiscovery(temporary);
      expect(discovery.fallback).toEqual([]);
      expect(discovery.patterns).toEqual([
        'server/checks/**/*.test.ts',
        'webview-ui/checks/*.test.ts',
        'e2e/specs/**/*.spec.ts',
      ]);
      expect(isExecutedTest('webview-ui/checks/a.test.ts', temporary)).toBe(true);
      expect(webviewTestMirrors('webview-ui/src/a.ts', temporary)).toEqual([
        'webview-ui/checks/a*.test.ts',
      ]);
      fs.writeFileSync(
        path.join(temporary, 'server/vitest.config.ts'),
        'export default { test: { include: computeIncludes(), } };',
      );
      expect(testDiscovery(temporary).fallback).toEqual(['server/vitest.config.ts']);
      expect(isExecutedTest('server/__tests__/fallback.test.ts', temporary)).toBe(true);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
  it('has no fallback or drift against independent AST reads of real configs', () => {
    const discovery = testDiscovery(repo);
    expect(discovery.fallback).toEqual([]);
    for (const [workspace, patterns] of [
      ['server', discovery.server],
      ['webview-ui', discovery.webview],
    ] as const) {
      const source = ts.createSourceFile(
        'config.ts',
        fs.readFileSync(path.join(repo, workspace, 'vitest.config.ts'), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const includes: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'include') {
          expect(ts.isArrayLiteralExpression(node.initializer)).toBe(true);
          if (ts.isArrayLiteralExpression(node.initializer))
            for (const item of node.initializer.elements) {
              expect(ts.isStringLiteral(item)).toBe(true);
              if (ts.isStringLiteral(item)) includes.push(`${workspace}/${item.text}`);
            }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(patterns).toEqual(includes);
    }
    // Pin the supported Playwright default and directory independently: any config
    // change requires this drift assertion to be revisited, never silently fallback.
    const playwright = fs.readFileSync(path.join(repo, 'e2e/playwright.config.ts'), 'utf8');
    expect(playwright).toMatch(/testDir:\s*path.join\(__dirname, 'tests'\)/);
    expect(playwright).not.toMatch(/\btestMatch\s*:/);
    expect(discovery.playwright).toHaveLength(24);
    expect(discovery.playwright.every((glob) => glob.startsWith('e2e/tests/'))).toBe(true);
    expect(new Set(discovery.playwright)).toEqual(
      new Set(
        ['spec', 'test'].flatMap((kind) =>
          [
            'js',
            'jsx',
            'ts',
            'tsx',
            'cjs',
            'cjsx',
            'cts',
            'ctsx',
            'mjs',
            'mjsx',
            'mts',
            'mtsx',
          ].map((extension) => `e2e/tests/**/*.${kind}.${extension}`),
        ),
      ),
    );
    expect(vitestWorkspace(repo, 'server/__tests__/testRoots.test.ts').include).toEqual(
      discovery.server.map((glob) => glob.slice('server/'.length)),
    );
    expect(vitestWorkspace(repo, 'webview-ui/test/a.test.ts').include).toEqual(
      discovery.webview.map((glob) => glob.slice('webview-ui/'.length)),
    );
  });

  it('matches executed patterns rather than accepting every file under a root', () => {
    for (const file of [
      'server/__tests__/nested/a.test.ts',
      'webview-ui/test/a.test.ts',
      'e2e/tests/standalone/a.spec.ts',
    ])
      expect(isExecutedTest(file, repo)).toBe(true);
    for (const file of [
      'server/__tests__/a.spec.ts',
      'webview-ui/test/nested/a.test.ts',
      'e2e/a.spec.ts',
      'server/src/a.test.ts',
    ])
      expect(isExecutedTest(file, repo)).toBe(false);
    expect(webviewTestMirrors('webview-ui/src/components/Panel.tsx', repo)).toEqual([
      'webview-ui/test/Panel*.test.ts',
    ]);
  });

  it('gives Reviewer a runtime false flag for tests outside discovery', () => {
    const input = {
      worktree: repo,
      files: ['server/src/outside.test.ts', 'server/__tests__/testRoots.test.ts'],
    } as ReviewerRequest;
    const brief = JSON.parse(reviewerBrief(input));
    expect(brief.taskTests).toEqual([
      { file: input.files[0], executed: false },
      { file: input.files[1], executed: true },
    ]);
    expect(brief.testExecutionRule).toContain('Request changes');
    expect(
      JSON.parse(reviewerBrief({ ...input, changedTestFiles: [input.files[1]] })).taskTests,
    ).toEqual([{ file: input.files[1], executed: true }]);
    const scope = developerScope(
      { changeZones: ['webview-ui/src/components/Panel.tsx'] } as ReviewerRequest['task'],
      repo,
    );
    expect(scope.mirroredTestZones).toEqual(
      webviewTestMirrors('webview-ui/src/components/Panel.tsx', repo),
    );
    expect(scope.testDiscovery.patterns).toEqual(testDiscovery(repo).patterns);
  });
});
