import typescriptEslint from 'typescript-eslint';

import pixelAgentsPlugin from './pixel-agents-rules.mjs';

/** Runtime-owned additional pass. Project configuration is loaded by its own lint command. */
export default [
  {
    files: ['**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}'],
    languageOptions: {
      parser: typescriptEslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      '@typescript-eslint': typescriptEslint.plugin,
      'pixel-agents': pixelAgentsPlugin,
    },
    rules: {
      'pixel-agents/hexagonal-boundaries': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'pixel-agents/no-double-cast': 'error',
      'pixel-agents/assertion-safety': 'warn',
      'max-lines': ['warn', { max: 1000, skipBlankLines: false, skipComments: false }],
    },
  },
];
