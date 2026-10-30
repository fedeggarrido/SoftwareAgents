/** Reviewer content only. Runtime bindings and transitions are never model output. */
export interface ReviewReport {
  /** Runtime audit copy, excluded from model ingress. */
  originalReport?: ReviewReport;
  runtimeNotes?: string[];
  verdict: 'approve' | 'request_changes';
  findings: {
    severity: 'blocker' | 'major' | 'minor' | 'nit';
    file: string;
    line?: number;
    evidence?: string;
    downgradeReasons?: string[];
    summary: string;
    suggestion: string;
  }[];
  acCoverage?: { ac: string; status: 'covered' | 'missing' | 'partial' }[];
}
