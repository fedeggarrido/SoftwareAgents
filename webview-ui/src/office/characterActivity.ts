import { CHARACTER_ACTIVITY_TEXT, RELATIVE_MINUTE_MS, WORK_STATE } from '../constants.js';
import { knownText } from './displayText.js';
import { spanishToolStatus } from './toolUtils.js';
import type { Character, ToolActivity } from './types.js';

type ActivityCharacter = Pick<
  Character,
  | 'isActive'
  | 'isInMeeting'
  | 'hasDomainWork'
  | 'bubbleType'
  | 'waitingAwaitingInput'
  | 'workState'
  | 'waitingSince'
>;
export type CharacterActivity = keyof typeof CHARACTER_ACTIVITY_TEXT;

/** Shared by the label, animation and workstation. Tool history never decides liveness. */
export function characterActivity(ch: ActivityCharacter): CharacterActivity {
  if (ch.bubbleType === 'permission' || ch.workState === WORK_STATE.WAITING_HUMAN)
    return 'needs_you';
  if (ch.isInMeeting) return 'meeting';
  if (
    ch.waitingAwaitingInput ||
    (ch.workState &&
      [
        WORK_STATE.WAITING_QUOTA,
        WORK_STATE.WAITING_DEPENDENCY,
        WORK_STATE.BLOCKED,
        WORK_STATE.FAILED,
      ].some((state) => state === ch.workState))
  )
    return 'waiting';
  return ch.isActive || ch.hasDomainWork ? 'working' : 'waiting';
}

export function characterActivityLabel(
  ch: ActivityCharacter,
  tools: readonly ToolActivity[] = [],
  now = Date.now(),
): string {
  const state = characterActivity(ch);
  if (state === 'needs_you' || state === 'meeting') return CHARACTER_ACTIVITY_TEXT[state];
  if (state === 'waiting') {
    if (ch.waitingAwaitingInput) return 'Esperando tu respuesta';
    const minutes = Math.max(0, Math.floor((now - (ch.waitingSince ?? now)) / RELATIVE_MINUTE_MS));
    return `En espera desde hace ${minutes} min`;
  }
  const tool = [...tools].reverse().find((row) => !row.done) ?? tools.at(-1);
  const activity = tool && knownText(spanishToolStatus(tool.status));
  return activity
    ? `${CHARACTER_ACTIVITY_TEXT.working} · ${activity}`
    : CHARACTER_ACTIVITY_TEXT.working;
}

export function characterDisplayName(
  ch: Pick<Character, 'agentName' | 'isTeamLead' | 'isSubagent'>,
  role: string | undefined,
  provider: string,
  subtask?: string,
): string {
  if (ch.isSubagent && subtask) return knownText(spanishToolStatus(subtask)) ?? 'Subagente';
  if (ch.isTeamLead) return 'Responsable';
  return knownText(ch.agentName) ?? (role === 'Dueño' ? undefined : knownText(role)) ?? provider;
}

/** A blocked CLI may remain seated for approval; waiting work cannot route back to a desk. */
export function shouldCharacterSit(ch: ActivityCharacter): boolean {
  return (
    ch.isInMeeting ||
    (characterActivity(ch) !== 'waiting' && (ch.isActive || ch.hasDomainWork === true))
  );
}
