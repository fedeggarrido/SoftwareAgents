import * as fs from 'fs';
import * as path from 'path';

/** Real format/lint subprocesses, with tiny config in the disposable repository. */
export function developerVerifierConfig(repo: string): void {
  fs.mkdirSync(path.join(repo, 'server/src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'server/src/baseline.ts'), 'export {};\n');
  fs.copyFileSync(
    path.resolve(__dirname, '../../../.prettierrc.json'),
    path.join(repo, '.prettierrc.json'),
  );
  fs.writeFileSync(
    path.join(repo, 'eslint.config.mjs'),
    `import ts from 'typescript-eslint';
import sort from 'eslint-plugin-simple-import-sort';
export default [{ files: ['**/*.ts'], languageOptions: { parser: ts.parser }, plugins: { 'simple-import-sort': sort }, rules: { 'no-debugger': 'error', 'simple-import-sort/imports': 'error' } }];\n`,
  );
}
