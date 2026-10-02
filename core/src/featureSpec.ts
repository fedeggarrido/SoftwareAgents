/** Declarative Project Brain behavior; this specification grants no execution authority. */
export interface FeatureSpec {
  apiVersion: 'softwareagents.io/v1alpha1';
  kind: 'FeatureSpec';
  key: string;
  version: string;
  status: 'draft' | 'proposed' | 'approved' | 'superseded';
  title: string;
  goal: string;
  userValue: string;
  actors: string[];
  flows: string[];
  rules: string[];
  edgeCases: string[];
  acceptance: { id: string; given: string; when: string; then: string }[];
  openQuestions: string[];
  /** References only; consumers must authorize and contain any subsequent access. */
  links: { adr: string[]; clickup: string[] };
}
