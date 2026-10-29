import { useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import {
  CHARACTER_SITTING_OFFSET_PX,
  CLAUDE_LABEL_COLOR,
  CODEX_LABEL_COLOR,
  CONTEXT_CRITICAL_THRESHOLD,
  CONTEXT_DANGER_THRESHOLD,
  CONTEXT_GAUGE_BG,
  CONTEXT_GAUGE_COLOR_CRITICAL,
  CONTEXT_GAUGE_COLOR_DANGER,
  CONTEXT_GAUGE_COLOR_OK,
  CONTEXT_GAUGE_COLOR_WARN,
  CONTEXT_GAUGE_HEIGHT_PX,
  CONTEXT_GAUGE_WIDTH_PX,
  CONTEXT_WARN_THRESHOLD,
  DEPARTMENT_COLORS,
  TEAM_LEAD_COLOR,
  TEAM_ROLE_COLOR,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js';
import { useBoard } from '../boardStore.js';
import type { OfficeState } from '../engine/officeState.js';
import { useExecutorStore } from '../executorStore.js';
import { overlayProjection } from '../projection.js';
import { assignmentReason, getAgentRole, getProviderLabel, modelTierLabel } from '../toolUtils.js';
import type { ToolActivity } from '../types.js';
import { CharacterState } from '../types.js';

// Both turn-end states show the green checkmark bubble. A finished turn (Stop)
// shows ONLY the checkmark (the label falls through to its normal idle text);
// going idle waiting on the user (Notification(idle_prompt)) additionally
// surfaces this label. Driven by Character.waitingAwaitingInput.
const WAITING_INPUT_ACTIVITY_TEXT = 'Waiting for input';

interface ToolOverlayProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onCloseAgent: (id: number) => void;
  alwaysShowOverlay: boolean;
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
  bubbleType: 'permission' | 'waiting' | null,
  waitingAwaitingInput: boolean,
): string {
  if (bubbleType === 'permission') return 'Needs approval';
  // Only the idle case ("Waiting for input") gets a dedicated label. A finished
  // turn (Stop, waitingAwaitingInput=false) falls through so the checkmark alone
  // signals "done", same as the original behavior.
  if (bubbleType === 'waiting' && waitingAwaitingInput) return WAITING_INPUT_ACTIVITY_TEXT;

  const tools = agentTools[agentId];
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done);
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval';
      return activeTool.status;
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) return lastTool.status;
    }
  }

  return 'Idle';
}

function getFuelColor(ratio: number): string {
  if (ratio >= CONTEXT_CRITICAL_THRESHOLD) return CONTEXT_GAUGE_COLOR_CRITICAL;
  if (ratio >= CONTEXT_DANGER_THRESHOLD) return CONTEXT_GAUGE_COLOR_DANGER;
  if (ratio >= CONTEXT_WARN_THRESHOLD) return CONTEXT_GAUGE_COLOR_WARN;
  return CONTEXT_GAUGE_COLOR_OK;
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
  alwaysShowOverlay,
}: ToolOverlayProps) {
  const board = useBoard();
  // A Project whose server announces executor state manages its launches (SA-091).
  const managedProject = useExecutorStore().state !== null;
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el) return null;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );

  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)];

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch) return null;

        const isSelected = selectedId === id;
        const isHovered = hoveredId === id;
        const isSub = ch.isSubagent;

        // Only show for hovered or selected agents (unless always-show is on)
        if (!alwaysShowOverlay && !isSelected && !isHovered) return null;

        // Position above character
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        const screenX = project.toScreenX(ch.x);
        const screenY = project.toScreenY(ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET);

        // A "Done" agent (finished turn: waiting bubble without awaitingInput)
        // shows ONLY its floating green checkmark bubble, never the label panel
        // (the panel would cover the bubble). Render an empty positioned marker
        // so overlay counts stay stable and hover/select can still bring the
        // panel back. When always-show is off, the early return above already
        // keeps the panel hidden for idle agents.
        const isDone = ch.bubbleType === 'waiting' && !ch.waitingAwaitingInput;
        if (isDone && !isSelected && !isHovered) {
          return (
            <div
              key={id}
              className="absolute"
              style={{ left: screenX, top: screenY, pointerEvents: 'none' }}
              data-testid="agent-overlay"
              data-agent-id={id}
            />
          );
        }

        // Get activity text
        const hasWaitingBubble = ch.bubbleType === 'waiting';
        const subHasPermission = isSub && ch.bubbleType === 'permission';
        let activityText: string;
        if (hasWaitingBubble && ch.waitingAwaitingInput) {
          // Idle, waiting on the user -> dedicated label. A finished turn (Stop)
          // shows only the checkmark and falls through to the normal idle text.
          activityText = WAITING_INPUT_ACTIVITY_TEXT;
        } else if (isSub) {
          if (subHasPermission) {
            activityText = 'Needs approval';
          } else {
            // Hover shows the subtask title; SELECTING the sub reveals its live
            // tool activity (watched sub-agents stream it via subagentToolStart).
            const sub = subagentCharacters.find((s) => s.id === id);
            const rows = sub ? subagentTools[sub.parentAgentId]?.[sub.parentToolId] : undefined;
            const activeRow =
              isSelected && rows ? [...rows].reverse().find((t) => !t.done) : undefined;
            activityText = activeRow?.status ?? (sub?.label || 'Subtask');
          }
        } else {
          activityText = getActivityText(
            id,
            agentTools,
            ch.isActive,
            ch.bubbleType,
            ch.waitingAwaitingInput ?? false,
          );
        }

        // Determine dot color
        const tools = agentTools[id];
        const hasPermission = subHasPermission || tools?.some((t) => t.permissionWait && !t.done);
        const hasActiveTools = tools?.some((t) => !t.done);
        const isActive = ch.isActive;
        const hasWaiting = ch.bubbleType === 'waiting';

        let dotColor: string | null = null;
        if (hasPermission || hasWaiting) {
          dotColor = 'var(--color-status-permission)';
        } else if (isActive && hasActiveTools) {
          dotColor = 'var(--color-status-active)';
        }

        // Team info
        const teamRoleLabel = ch.isTeamLead ? 'LEAD' : ch.agentName || null;
        const providerName = isSub ? null : getProviderLabel(id);
        const companyRole = isSub ? undefined : getAgentRole(id);
        const rawTask = companyRole?.detail?.replace(/^tarea\s+/, '');
        const boardTask = board?.items.find((i) => i.clickupId === rawTask || i.id === rawTask);
        const taskDetail = boardTask ? `${boardTask.id} · ${boardTask.title}` : companyRole?.detail;
        const hasExtraLines = !!(ch.folderName || teamRoleLabel || providerName || companyRole);

        // Context gauge. Every agent gets one — lead, teammate, adopted,
        // headless — as soon as it has taken a turn. Sub-agents never do: they
        // have no session of their own, so contextTokens stays 0.
        const contextRatio = ch.contextTokens / ch.maxContextTokens;
        const showContextGauge = !isSub && ch.contextTokens > 0;

        // Always-on labels stay out of the way: one small pill (role · task and
        // the status dot). The full panel is for the hovered or selected agent.
        if (alwaysShowOverlay && !isSelected && !isHovered) {
          if (isSub) return null;
          // Show the backlog id (FT-OPP-001) rather than the ClickUp one.
          const task = boardTask?.id ?? rawTask;
          return (
            <div
              key={id}
              className="absolute -translate-x-1/2"
              style={{ left: screenX, top: screenY - 16, pointerEvents: 'none', zIndex: 20 }}
              data-testid="agent-overlay"
              data-agent-id={id}
            >
              <div
                className="flex items-center gap-3 px-4 py-1 pixel-panel whitespace-nowrap"
                style={{ opacity: 0.85 }}
              >
                {dotColor && (
                  <span
                    className="w-5 h-5 rounded-full shrink-0"
                    style={{ background: dotColor }}
                  />
                )}
                <span
                  className="text-2xs leading-none"
                  style={{
                    color: companyRole
                      ? (DEPARTMENT_COLORS[companyRole.department] ?? CLAUDE_LABEL_COLOR)
                      : providerName?.startsWith('Codex')
                        ? CODEX_LABEL_COLOR
                        : CLAUDE_LABEL_COLOR,
                  }}
                  data-testid="agent-pill"
                  title={taskDetail}
                >
                  {companyRole?.label ?? providerName ?? 'Agente'}
                  {task ? ` · ${task}` : ''}
                </span>
                {/* The pill stays visually compact; the current activity remains in the
                    accessible text (screen readers, e2e) without widening the label. */}
                <span className="sr-only">{activityText}</span>
              </div>
            </div>
          );
        }

        return (
          <div
            key={id}
            className="absolute flex flex-col items-center -translate-x-1/2"
            style={{
              left: screenX,
              top: screenY - (hasExtraLines ? 34 : 28),
              pointerEvents: isSelected ? 'auto' : 'none',
              opacity: alwaysShowOverlay && !isSelected && !isHovered ? (isSub ? 0.5 : 0.75) : 1,
              zIndex: isSelected ? 21 : 20,
            }}
            data-testid="agent-overlay"
            data-agent-id={id}
          >
            <div className="flex items-center border-border px-8 pt-2 pb-4 gap-5 pixel-panel whitespace-nowrap max-w-2xs">
              {dotColor && (
                <span
                  className={`w-6 h-6 rounded-full shrink-0 ${isActive && !hasPermission && !hasWaiting ? 'pixel-pulse' : ''}`}
                  style={{ background: dotColor }}
                />
              )}
              <div className="flex flex-col gap-0 overflow-hidden">
                {companyRole && (
                  <span
                    className="overflow-hidden text-ellipsis block leading-none"
                    style={{
                      fontSize: '18px',
                      fontWeight: 'bold',
                      color: DEPARTMENT_COLORS[companyRole.department] ?? CLAUDE_LABEL_COLOR,
                    }}
                    data-testid="agent-role"
                  >
                    {companyRole.label}
                    {companyRole.detail && (
                      <span style={{ fontWeight: 'normal', opacity: 0.8 }}> · {taskDetail}</span>
                    )}
                  </span>
                )}
                {providerName && (
                  <span
                    className="overflow-hidden text-ellipsis block leading-none"
                    style={{
                      fontSize: '18px',
                      fontWeight: 'bold',
                      color: providerName.startsWith('Codex')
                        ? CODEX_LABEL_COLOR
                        : CLAUDE_LABEL_COLOR,
                    }}
                    data-testid="agent-provider"
                  >
                    {providerName}
                  </span>
                )}
                {modelTierLabel(companyRole) && (
                  <span
                    className="text-2xs leading-none overflow-hidden text-ellipsis block"
                    data-testid="agent-model-tier"
                    title={[companyRole?.model, companyRole?.effort, companyRole?.selectionReason]
                      .filter(Boolean)
                      .join(' · ')}
                  >
                    {modelTierLabel(companyRole)}
                  </span>
                )}
                {!isSub && assignmentReason(companyRole, managedProject) && (
                  <span
                    className="text-2xs leading-none overflow-hidden text-ellipsis whitespace-nowrap block text-text-muted"
                    data-testid="agent-assignment-reason"
                    title={assignmentReason(companyRole, managedProject)}
                  >
                    {assignmentReason(companyRole, managedProject)}
                  </span>
                )}
                {teamRoleLabel && (
                  <span
                    className="overflow-hidden text-ellipsis block leading-none"
                    style={{
                      fontSize: '18px',
                      color: ch.isTeamLead ? TEAM_LEAD_COLOR : TEAM_ROLE_COLOR,
                      fontWeight: ch.isTeamLead ? 'bold' : undefined,
                    }}
                  >
                    {teamRoleLabel}
                  </span>
                )}
                <span
                  className="overflow-hidden text-ellipsis block leading-none"
                  style={{
                    fontSize: isSub ? '20px' : '22px',
                    fontStyle: isSub ? 'italic' : undefined,
                  }}
                >
                  {activityText}
                </span>
                {ch.folderName && (
                  <span className="text-2xs leading-none overflow-hidden text-ellipsis block">
                    {ch.folderName}
                  </span>
                )}
              </div>
              {isSelected && !isSub && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseAgent(id);
                  }}
                  title="Close agent"
                  className="ml-2 shrink-0 leading-none"
                >
                  ×
                </Button>
              )}
            </div>
            {showContextGauge && (
              <div
                style={{
                  width: CONTEXT_GAUGE_WIDTH_PX,
                  height: CONTEXT_GAUGE_HEIGHT_PX,
                  background: CONTEXT_GAUGE_BG,
                  marginTop: 2,
                }}
                title={`${Math.round(contextRatio * 100)}% context used (${(ch.contextTokens / 1000).toFixed(0)}k of ${(ch.maxContextTokens / 1000).toFixed(0)}k tokens)`}
                data-testid="context-gauge"
                data-context-pct={Math.round(contextRatio * 100)}
              >
                <div
                  style={{
                    width: `${Math.min(contextRatio * 100, 100)}%`,
                    height: '100%',
                    background: getFuelColor(contextRatio),
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
