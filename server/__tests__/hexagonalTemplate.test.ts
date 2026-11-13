import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Linter } from 'eslint';
import typescriptEslint from 'typescript-eslint';
import { afterEach, describe, expect, it } from 'vitest';

import rule from '../../eslint-rules/hexagonal-boundaries.mjs';
import { HEXAGONAL_MARKER, HEXAGONAL_RULE_ID } from '../src/projectArchitectureConstants.js';
import {
  architectureTemplateLanguage,
  hexagonalTemplate,
  scaffoldHexagonalProject,
} from '../src/projectArchitectureTemplate.js';
import { reviewVerifierFeedback } from '../src/reviewPasses.js';
import { styleOnlyFailures, verifierFailure } from '../src/verifierFeedback.js';

const roots: string[] = [];
function tmpRoot(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sa158-tpl-')));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('SA-158 hexagonal template', () => {
  it('maps the human stack language to a template flavour', () => {
    expect(architectureTemplateLanguage('TypeScript 5 + Node')).toBe('ts');
    expect(architectureTemplateLanguage('Node.js 22')).toBe('js');
    expect(architectureTemplateLanguage('Go 1.23')).toBe('layout');
  });

  it('publishes the opt-in marker last and only layout for unknown languages', () => {
    const files = [...hexagonalTemplate('Go').keys()];
    expect(files.at(-1)).toBe(HEXAGONAL_MARKER);
    expect(files.some((file) => /\.[jt]s$/.test(file))).toBe(false);
  });

  it('keeps existing files and creates only the missing ones', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'src/domain'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/domain/greeting.ts'), 'mine');
    const created = scaffoldHexagonalProject(root, 'TypeScript');
    expect(created).not.toContain('src/domain/greeting.ts');
    expect(fs.readFileSync(path.join(root, 'src/domain/greeting.ts'), 'utf8')).toBe('mine');
    expect(created).toContain(HEXAGONAL_MARKER);
    expect(scaffoldHexagonalProject(root, 'TypeScript')).toEqual([]);
  });

  it('generates example code that respects its own layer rule', () => {
    const root = tmpRoot();
    scaffoldHexagonalProject(root, 'TypeScript');
    const linter = new Linter({ cwd: root });
    const config: Linter.Config = {
      files: ['**/*.ts'],
      languageOptions: { parser: typescriptEslint.parser },
      plugins: { hex: { rules: { boundaries: rule } } },
      rules: { 'hex/boundaries': ['error', { root }] },
    };
    for (const [file, content] of hexagonalTemplate('TypeScript')) {
      if (!file.endsWith('.ts')) continue;
      const messages = linter.verify(content, config, path.join(root, file));
      expect(messages, file).toEqual([]);
    }
  });
});

describe('SA-158 boundary findings block review', () => {
  const root = path.resolve('/project');
  const eslintJson = JSON.stringify([
    {
      filePath: path.join(root, 'src/domain/order.ts'),
      messages: [
        {
          ruleId: HEXAGONAL_RULE_ID,
          severity: 2,
          line: 3,
          message: 'domain no puede importar out',
        },
        { ruleId: 'no-console', severity: 2, line: 4, message: 'console' },
      ],
    },
    { filePath: path.resolve('/elsewhere/x.ts'), messages: [] },
  ]);

  it('extracts only hexagonal errors inside the project root', () => {
    const failure = verifierFailure(
      'eslint',
      ['eslint', '--format', 'json'],
      [],
      'fail',
      eslintJson,
      [root],
    );
    expect(failure.boundaries).toEqual([
      { file: 'src/domain/order.ts', line: 3, message: 'domain no puede importar out' },
    ]);
    expect(styleOnlyFailures([failure])).toBe(false);
  });

  it('ignores malformed tool output', () => {
    const failure = verifierFailure('eslint', ['eslint'], [], 'fail', 'not json', [root]);
    expect(failure.boundaries).toBeUndefined();
    expect(styleOnlyFailures([failure])).toBe(true);
  });

  it('turns an approval into request_changes with a major boundaries finding', () => {
    const failure = verifierFailure('eslint', ['eslint'], [], 'fail', eslintJson, [root]);
    const report = reviewVerifierFeedback({ verdict: 'approve', findings: [] }, [failure]);
    expect(report.verdict).toBe('request_changes');
    expect(report.findings).toMatchObject([
      { severity: 'major', category: 'boundaries', file: 'src/domain/order.ts', line: 3 },
    ]);
    expect(reviewVerifierFeedback({ verdict: 'approve', findings: [] }, []).verdict).toBe(
      'approve',
    );
  });
});
