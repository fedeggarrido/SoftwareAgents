import type { AuditViewEntry } from '../../../core/src/messages.js';
import { AUDIT_ACTION_TEXT, AUDIT_ACTOR_TEXT, AUDIT_OUTCOME_TEXT } from '../constants.js';
import { knownText, relativeTime } from './displayText.js';

export function auditSentence(entry: AuditViewEntry, now = Date.now()): string {
  const actor = AUDIT_ACTOR_TEXT[entry.actorType] ?? AUDIT_ACTOR_TEXT.unknown;
  const name = knownText(entry.actorId);
  const action =
    AUDIT_ACTION_TEXT[entry.action] ??
    `registró la acción «${knownText(entry.action) ?? 'sin nombre'}»`;
  const task = knownText(entry.taskKey);
  const at = Date.parse(entry.occurredAt);
  const outcome = AUDIT_OUTCOME_TEXT[entry.outcome.status] ?? knownText(entry.outcome.status);
  return `${actor}${name ? ` (${name})` : ''} ${action}${task ? ` en ${task}` : ''}${Number.isFinite(at) ? `, ${relativeTime(at, now)}` : ', fecha no válida'}${outcome ? `; resultado: ${outcome}` : ''}.`;
}
