export const DESIGN_RUBRIC = [
  'hierarchy',
  'legibility',
  'coherence',
  'accessibilityContrast',
  'density',
  'states',
  'antiPatterns',
] as const;
export interface DesignValidation {
  kind: 'contrast' | 'capture' | 'interaction' | 'accessibility';
  tool: string;
  result: 'pass' | 'fail' | 'not_tested';
  evidence: string;
}
export interface DesignReport {
  verdict: 'approve' | 'request_changes';
  findings: {
    severity: 'blocker' | 'major' | 'minor' | 'nit';
    screen: string;
    area: string;
    problem: string;
    principle: string;
    fix: string;
    id?: string;
    regression?: boolean;
    majorJustification?: string;
  }[];
  rubric: Record<(typeof DESIGN_RUBRIC)[number], number>;
  validations: DesignValidation[];
}
