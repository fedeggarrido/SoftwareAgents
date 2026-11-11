import { RuleTester } from 'eslint';
import typescriptEslint from 'typescript-eslint';
import { describe, it } from 'vitest';

import plugin from '../../eslint-rules/pixel-agents-rules.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { parser: typescriptEslint.parser } });

describe('SA-155 lint rules', () => {
  tester.run('no-double-cast', plugin.rules['no-double-cast'], {
    valid: ['const a = b as Foo;', 'const a = b as unknown;'],
    invalid: [{ code: 'const a = b as unknown as Foo;', errors: [{ messageId: 'doubleCast' }] }],
  });

  tester.run('assertion-safety', plugin.rules['assertion-safety'], {
    valid: [
      'const a = [1] as const;',
      '// SAFETY: parsed JSON was validated by the schema above.\nconst a = b as Foo;',
    ],
    invalid: [{ code: 'const a = b as Foo;', errors: [{ messageId: 'missing' }] }],
  });
});
