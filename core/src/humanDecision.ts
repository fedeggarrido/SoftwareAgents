/** A scoped response never grants blanket execution authority. */
export interface HumanDecisionOption {
  id: string;
  label: string;
  benefit: string;
  cost: string;
  risk: string;
}
export interface HumanDecision {
  id: string;
  context: string;
  options: HumanDecisionOption[];
  recommendation: string;
  disagreement: { role: string; position: string }[];
  impact: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  requestedBy: string;
  blocks: string[];
  status: 'open' | 'answered' | 'expired';
  answer?: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
}
export type NewHumanDecision = Omit<
  HumanDecision,
  'status' | 'answer' | 'answeredBy' | 'answeredAt'
>;
