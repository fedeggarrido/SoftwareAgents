import typescriptEslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import pixelAgentsPlugin from './eslint-rules/pixel-agents-rules.mjs';

export default [
  {
    files: ['**/*.ts'],
  },
  {
    plugins: {
      '@typescript-eslint': typescriptEslint.plugin,
      'simple-import-sort': simpleImportSort,
      'pixel-agents': pixelAgentsPlugin,
    },

    languageOptions: {
      parser: typescriptEslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },

    rules: {
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'import',
          format: ['camelCase', 'PascalCase'],
        },
      ],

      curly: 'error',
      eqeqeq: 'error',
      'no-throw-literal': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'pixel-agents/no-inline-colors': 'error',
    },
  },
  {
    // SA-155 honest types and size for product code. Assertion reasons and file size
    // warn while the existing debt is burned down; new double casts and `any` fail.
    files: ['server/src/**/*.ts', 'core/src/**/*.ts', 'adapters/vscode/**/*.ts'],
    // messages.ts is generated from core/asyncapi.yaml and never edited by hand.
    ignores: ['core/src/messages.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'pixel-agents/no-double-cast': 'error',
      'pixel-agents/assertion-safety': 'warn',
      'max-lines': ['warn', { max: 1000, skipBlankLines: false, skipComments: false }],
    },
  },
  {
    // Shrink-only list of files that predate SA-155 and still use `as unknown as`.
    // Remove a file from this list when its double casts are gone.
    files: [
      'server/src/boardWatcher.ts',
      'server/src/configPersistence.ts',
      'server/src/designCaptureHost.ts',
      'server/src/domainEventRelay.ts',
      'server/src/executorState.ts',
      'server/src/featurePlan.ts',
      'server/src/featuresView.ts',
      'server/src/fileStateAdapter.ts',
      'server/src/flowCommand.ts',
      'server/src/usageBackfill.ts',
      'server/src/usageCommand.ts',
      'server/src/workstore/SqliteWorkStore.ts',
      'server/src/zonesCheck.ts',
    ],
    rules: {
      'pixel-agents/no-double-cast': 'off',
    },
  },
  {
    files: ['adapters/vscode/constants.ts'],
    rules: {
      'pixel-agents/no-inline-colors': 'off',
    },
  },
  eslintConfigPrettier,
];
