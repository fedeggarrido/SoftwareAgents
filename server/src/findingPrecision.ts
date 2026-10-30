export interface FindingDecision {
  task: string;
  feature: string | null;
  execution: string;
  index: number;
  role: string;
  executor: string;
  model: string;
  severity: string;
  downgradeReasons: string[];
  decision: 'accept' | 'reject';
  reason?: string;
  actor: 'human';
  decidedAt: string;
}

export function findingPrecision(rows: FindingDecision[]) {
  const groups = new Map<
    string,
    { role: string; executor: string; model: string; severity: string; n: number; accepted: number }
  >();
  const downgraded: Record<string, number> = {};
  for (const row of rows) {
    const key = JSON.stringify([row.role, row.executor, row.model, row.severity]);
    const group = groups.get(key) ?? {
      role: row.role,
      executor: row.executor,
      model: row.model,
      severity: row.severity,
      n: 0,
      accepted: 0,
    };
    group.n++;
    if (row.decision === 'accept') group.accepted++;
    groups.set(key, group);
    for (const reason of row.downgradeReasons) downgraded[reason] = (downgraded[reason] ?? 0) + 1;
  }
  return {
    groups: [...groups.values()].map((group) => ({
      ...group,
      acceptanceRate: group.accepted / group.n,
    })),
    downgraded,
  };
}
