/** Reviewer content only. Runtime bindings and transitions are never model output. */
export interface ReviewReport {
  verdict: 'approve' | 'request_changes';
  findings: {
    severity: 'blocker' | 'major' | 'minor' | 'nit';
    file: string;
    line?: number;
    summary: string;
    suggestion: string;
  }[];
  acCoverage?: { ac: string; status: 'covered' | 'missing' | 'partial' }[];
}
