import * as fs from 'fs';

import { runResearchCommand as command } from '../../src/commands/research.js';
import {
  researchCostConfirmation,
  researchEstimate,
  researchPolicy,
} from '../../src/researchPolicy.js';

/** Legacy collection fixtures explicitly confirm budgets and inspect artifacts.
 * Production command output contains metadata only. */
export const runResearchCommand: typeof command = async (argv, cwd, log, options = {}) => {
  const policy = researchPolicy('quick', options.config?.operator.research);
  const confirmed = [
    ...argv,
    '--accept-cost',
    researchCostConfirmation(researchEstimate(policy.maxTokens), policy.maxCostUsd),
  ];
  await command(
    confirmed,
    cwd,
    (line) => {
      const value = (() => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })();
      if (value?.confirmation) return;
      if (value?.path) {
        const report = JSON.parse(fs.readFileSync(value.path.replace(/\.md$/, '.json'), 'utf8'));
        log?.(JSON.stringify(report));
      } else log?.(line);
    },
    options,
  );
};
