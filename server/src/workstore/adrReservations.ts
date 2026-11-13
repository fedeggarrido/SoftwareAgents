import type { DatabaseSync } from 'node:sqlite';

/** Caller holds the WorkStore write transaction. Reservations survive failed proposals. */
export function reserveAdrNumbers(
  db: DatabaseSync,
  project: string,
  feature: string,
  count: number,
  minimum: number,
  purpose: 'architecture' | 'stack',
): number[] {
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(minimum) || minimum < 0)
    throw new Error('Invalid ADR reservation');
  const reserved = db
    .prepare(
      'SELECT number FROM adr_reservations WHERE project_id = ? AND feature_key = ? AND purpose = ? ORDER BY ordinal',
    )
    .all(project, feature, purpose)
    .map((row) => Number(row.number));
  let number = Math.max(
    minimum,
    Number(
      db
        .prepare(
          'SELECT coalesce(max(number), 0) AS number FROM adr_reservations WHERE project_id = ?',
        )
        .get(project)!.number,
    ),
  );
  for (let ordinal = reserved.length; ordinal < count; ordinal++) {
    if (++number > 9999) throw new Error('ADR numbering exhausted');
    db.prepare(
      'INSERT INTO adr_reservations (project_id, feature_key, purpose, ordinal, number) VALUES (?, ?, ?, ?, ?)',
    ).run(project, feature, purpose, ordinal, number);
    reserved.push(number);
  }
  return reserved.slice(0, count);
}
