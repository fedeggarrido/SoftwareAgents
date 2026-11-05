import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { readTaskInput } from '../src/commands/taskFiles.js';
import { RESEARCH_REPORT_MAX_BYTES, TASK_CLI_INPUT_BYTES } from '../src/constants.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('keeps 1 MiB for human input while a saved report may reach its own limit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-input-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'report.json'), 'x'.repeat(TASK_CLI_INPUT_BYTES + 1));
  expect(() => readTaskInput(root, 'report.json')).toThrow('size limit');
  expect(readTaskInput(root, 'report.json', RESEARCH_REPORT_MAX_BYTES)).toHaveLength(
    TASK_CLI_INPUT_BYTES + 1,
  );
});
