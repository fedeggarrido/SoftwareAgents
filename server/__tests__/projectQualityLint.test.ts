import { ESLint } from 'eslint';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { developerStyleCommands } from '../src/developer.js';
import { projectQualityLintCommand } from '../src/projectQualityLint.js';
import { verifierKind } from '../src/verifierFeedback.js';

vi.mock('../src/evalIntegrity.js', async (original) => ({
  ...(await original<typeof import('../src/evalIntegrity.js')>()),
  evalChangedFiles: () => ['code.ts'],
}));

let root: string;
let base: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-quality-'));
  base = 'HEAD';
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function lint(source: string) {
  fs.writeFileSync(path.join(root, 'code.ts'), source);
  const command = projectQualityLintCommand(['code.ts'])[0];
  if (!('argv' in command)) throw new Error('Expected an ESLint command');
  expect(command.argv).toContain('--no-config-lookup');
  expect(command.argv).toContain('--no-inline-config');
  const config = command.argv[command.argv.indexOf('--config') + 1];
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: config,
    ignore: false,
    allowInlineConfig: false,
  });
  const results = await eslint.lintFiles(['code.ts']);
  const output = results
    .flatMap((result) => result.messages.map((message) => message.ruleId ?? message.message))
    .join('\n');
  return { result: results.some((result) => result.errorCount > 0) ? 'fail' : 'pass', output };
}

it('adds lint for a prepared project with no authored ESLint configuration', () => {
  fs.writeFileSync(path.join(root, 'code.ts'), 'export const code = 1;\n');
  const commands = developerStyleCommands(root, base);
  expect(
    commands.filter((command) => 'argv' in command && verifierKind(command.argv) === 'eslint'),
  ).toHaveLength(1);
  expect(fs.readdirSync(root).some((file) => file.startsWith('eslint.config'))).toBe(false);
});

it('preserves the project config and enforces rules even when it ignores changed files', async () => {
  const ownConfig = 'export default [{ ignores: ["**/*.ts"] }];\n';
  fs.writeFileSync(path.join(root, 'eslint.config.mjs'), ownConfig);
  const result = await lint('export const value: any = input as unknown as string;\n');
  expect(result.result).toBe('fail');
  expect(result.output).toContain('@typescript-eslint/no-explicit-any');
  expect(result.output).toContain('pixel-agents/no-double-cast');
  expect(result.output).toContain('pixel-agents/assertion-safety');
  expect(fs.readFileSync(path.join(root, 'eslint.config.mjs'), 'utf8')).toBe(ownConfig);
  expect(
    developerStyleCommands(root, base).filter(
      (command) => 'argv' in command && verifierKind(command.argv) === 'eslint',
    ),
  ).toHaveLength(2);
}, 30_000);

it('accepts justified assertions and const assertions', async () => {
  expect(
    await lint(
      '// SAFETY: value was validated above.\nexport const result = input as string;\nexport const names = ["name"] as const;\n',
    ),
  ).toMatchObject({ result: 'pass', output: '' });
}, 30_000);

it('warns at 1000 lines without failing the verifier', async () => {
  const result = await lint('export const value = 1;\n' + '\n'.repeat(1000));
  expect(result.result).toBe('pass');
  expect(result.output).toContain('max-lines');
}, 30_000);
