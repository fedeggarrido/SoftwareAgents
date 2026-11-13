import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RuleTester } from 'eslint';
import typescriptEslint from 'typescript-eslint';
import { afterAll, describe, it } from 'vitest';

import rule from '../../eslint-rules/hexagonal-boundaries.mjs';
import * as policy from '../../eslint-rules/hexagonal-policy.json';

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { parser: typescriptEslint.parser } });

// RuleTester registers cases synchronously, so the isolated projects exist up front.
const hexagonal = fs.mkdtempSync(path.join(os.tmpdir(), 'sa158-hex-'));
fs.mkdirSync(path.dirname(path.join(hexagonal, policy.marker)), { recursive: true });
fs.writeFileSync(path.join(hexagonal, policy.marker), JSON.stringify(policy.config));
const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'sa158-plain-'));
afterAll(() => {
  fs.rmSync(hexagonal, { recursive: true, force: true });
  fs.rmSync(plain, { recursive: true, force: true });
});

const inHex = (file: string) => path.join(hexagonal, file);
const options = [{ root: hexagonal }];

describe('SA-158 hexagonal-boundaries', () => {
  tester.run('hexagonal-boundaries', rule, {
    valid: [
      // Inward dependencies are allowed.
      {
        code: "import { greeting } from '../domain/greeting.js';",
        filename: inHex('src/application/greet.ts'),
        options,
      },
      {
        code: "import { greet } from '../../application/greet.js';",
        filename: inHex('src/adapters/in/cli.ts'),
        options,
      },
      {
        code: "import express from 'express';",
        filename: inHex('src/adapters/in/http.ts'),
        options,
      },
      {
        code: "import { cli } from '../adapters/in/cli.js';\nimport { db } from '../adapters/out/db.js';",
        filename: inHex('src/composition/main.ts'),
        options,
      },
      {
        code: "import { greeting } from '../domain';",
        filename: inHex('src/application/greet.ts'),
        options,
      },
      // Projects without the hexagonal marker are never touched.
      {
        code: "import { db } from '../adapters/out/db.js';",
        filename: path.join(plain, 'src/domain/order.ts'),
        options: [{ root: plain }],
      },
    ],
    invalid: [
      {
        code: "import { db } from '../adapters/out/db.js';",
        filename: inHex('src/domain/order.ts'),
        options,
        errors: [{ messageId: 'boundary' }],
      },
      {
        code: "import express from 'express';",
        filename: inHex('src/domain/order.ts'),
        options,
        errors: [{ messageId: 'boundary' }],
      },
      {
        code: "import { cli } from '../adapters/in/cli.js';",
        filename: inHex('src/application/greet.ts'),
        options,
        errors: [{ messageId: 'boundary' }],
      },
      {
        code: "import { db } from '../out/db.js';",
        filename: inHex('src/adapters/in/cli.ts'),
        options,
        errors: [{ messageId: 'boundary' }],
      },
      {
        code: 'const mod = await import(name);',
        filename: inHex('src/application/greet.ts'),
        options,
        errors: [{ messageId: 'boundary' }],
      },
      {
        code: "const db = module.require('../adapters/out/db.cjs');",
        filename: inHex('src/domain/order.ts'),
        options,
        errors: [{ messageId: 'boundary' }],
      },
      {
        code: `const db = require(${JSON.stringify(inHex('src/adapters/out/db.cjs'))});`,
        filename: inHex('src/adapters/in/cli.ts'),
        options,
        errors: [{ messageId: 'boundary' }],
      },
      {
        code: 'export const x = 1;',
        filename: inHex('src/misc/x.ts'),
        options,
        errors: [{ messageId: 'unassigned' }],
      },
    ],
  });
});
