/** QA content; commands are runtime evidence, never executable model instructions. */
export interface TestReport {
  verdict: 'pass' | 'fail' | 'not_tested';
  /** For deferred criteria, evidence explains why coverage belongs to a downstream task. */
  acceptance: {
    ac: string;
    status: 'pass' | 'fail' | 'not_tested' | 'deferred';
    evidence: string;
  }[];
  commands: {
    command: string;
    result: 'pass' | 'fail' | 'not_tested';
    passed: number;
    failed: number;
    reason?: string;
  }[];
  defects: {
    ac: string;
    severity: 'blocker' | 'major' | 'minor' | 'nit';
    summary: string;
    reproduction: string;
  }[];
}
