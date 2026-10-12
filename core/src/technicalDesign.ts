/** Front matter of a TechnicalDesign .md; declarative only, it grants no execution authority. */
export interface TechnicalDesign {
  apiVersion: 'softwareagents.io/v1alpha1';
  kind: 'TechnicalDesign';
  /** FeatureSpec key (`FEAT-###`) this design implements. */
  feature: string;
  version: string;
  status: 'draft' | 'proposed' | 'approved' | 'superseded';
  components: string[];
  risks: string[];
  /** ADR identifiers (`ADR-####`); references only, never fetched automatically. */
  adrs: string[];
}
