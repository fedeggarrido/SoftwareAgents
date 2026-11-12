export type ReviewCategory =
  | 'regression'
  | 'security'
  | 'simplification'
  | 'branching'
  | 'boundaries'
  | 'types'
  | 'size'
  | 'legibility';
export type ReviewPass = 'single' | 'bugs_security' | 'quality_structure';

/** Runtime bindings and audit fields are excluded from model ingress. */
export interface ReviewReport {
  /** Runtime audit copy, excluded from model ingress. */
  originalReport?: ReviewReport;
  runtimeNotes?: string[];
  passes?: {
    pass: ReviewPass;
    executionId: string;
    executor: 'claude' | 'codex';
    originalReport: ReviewReport;
    report: ReviewReport;
  }[];
  verdict: 'approve' | 'request_changes';
  findings: {
    severity: 'blocker' | 'major' | 'minor' | 'nit';
    /** Optional for reports produced before SA-155. */
    category?: ReviewCategory;
    file: string;
    line?: number;
    evidence?: string;
    downgradeReasons?: string[];
    summary: string;
    suggestion: string;
  }[];
  acCoverage?: { ac: string; status: 'covered' | 'missing' | 'partial' }[];
}
