import { useEffect, useState } from 'react';

import { CharacterDetailPanel } from '../../components/CharacterDetailPanel.js';
import { ContextGauge } from '../../components/ContextGauge.js';
import {
  CHARACTER_SITTING_OFFSET_PX,
  EXTERNAL_SESSION_LABEL,
  EXTERNAL_SESSION_TOOLTIP,
  TOOL_OVERLAY_VERTICAL_OFFSET,
  WORK_STATE,
} from '../../constants.js';
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js';
import type { AgentHistory } from '../agentHistory.js';
import { agentTask } from '../agentHistory.js';
import { useBoard } from '../boardStore.js';
import {
  characterActivity,
  characterActivityLabel,
  characterDisplayName,
} from '../characterActivity.js';
import type { OfficeState } from '../engine/officeState.js';
import { useExecutorStore } from '../executorStore.js';
import { overlayProjection } from '../projection.js';
import { assignmentReason, getAgentRole, getProviderLabel, modelTierLabel } from '../toolUtils.js';
import type { ToolActivity } from '../types.js';
import { CharacterState } from '../types.js';

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
  agentHistory: AgentHistory;
  onOpenBacklog: (taskKey?: string) => void;
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
  agentHistory,
  onOpenBacklog,
}: ToolOverlayProps) {
  const board = useBoard();
  // A Project whose server announces executor state manages its launches (SA-091).
  const executorState = useExecutorStore().state;
  const managedProject = executorState !== null;
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

  const selectedId = officeState.selectedAgentId;

  const el = containerRef.current;
  if (!el) return null;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );

  const hoveredId = officeState.hoveredAgentId;

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)];

  return (
    <>
      {selectedId !== null &&
        officeState.characters.has(selectedId) &&
        (() => {
          const ch = officeState.characters.get(selectedId)!;
          const role = getAgentRole(selectedId);
          const sub = subagentCharacters.find((row) => row.id === selectedId);
          const tools = sub
            ? subagentTools[sub.parentAgentId]?.[sub.parentToolId]
            : agentTools[selectedId];
          const task = agentTask(
            selectedId,
            role,
            officeState.agentProjects.get(selectedId),
            board,
          );
          return (
            <CharacterDetailPanel
              key={selectedId}
              agentId={selectedId}
              name={characterDisplayName(ch, role?.label, getProviderLabel(selectedId), sub?.label)}
              role={role?.label}
              statusState={characterActivity(ch)}
              status={characterActivityLabel(ch, tools)}
              assignment={assignmentReason(role, managedProject)}
              tier={modelTierLabel(role)}
              context={
                ch.contextTokens > 0
                  ? { used: ch.contextTokens, limit: ch.maxContextTokens }
                  : undefined
              }
              workspaceName={ch.folderName}
              teamName={ch.teamName}
              detail={role?.characterDetail}
              detailAt={agentHistory.detailAt(selectedId)}
              executorState={executorState}
              executor={getProviderLabel(selectedId)}
              model={role?.model}
              task={{ ...task, state: officeState.workStates.get(selectedId) }}
              history={agentHistory.events(selectedId)}
              anchor={{ x: project.toScreenX(ch.x), y: project.toScreenY(ch.y) }}
              onClose={() => {
                officeState.selectedAgentId = null;
                officeState.cameraFollowId = null;
              }}
              onCloseAgent={!ch.isSubagent ? () => onCloseAgent(selectedId) : undefined}
              onOpenBacklog={() => {
                officeState.selectedAgentId = null;
                officeState.cameraFollowId = null;
                onOpenBacklog(task.key);
              }}
            />
          );
        })()}
      {allIds.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch) return null;
        const isSelected = selectedId === id;
        const isHovered = hoveredId === id;
        const workState = officeState.workStates.get(id) ?? WORK_STATE.AVAILABLE;
        const hasWork = workState !== WORK_STATE.AVAILABLE;
        if (!alwaysShowOverlay && !isSelected && !isHovered && !hasWork) return null;
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        const screenX = project.toScreenX(ch.x);
        const screenY = project.toScreenY(ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET);
        // The card owns selected details. Keep a marker for projection/automation only.
        const hideLabel =
          isSelected ||
          (ch.isSubagent && !isHovered) ||
          (ch.bubbleType === 'waiting' && !ch.waitingAwaitingInput && !isHovered && !hasWork);
        const role = getAgentRole(id);
        const sub = subagentCharacters.find((row) => row.id === id);
        const tools = sub ? subagentTools[sub.parentAgentId]?.[sub.parentToolId] : agentTools[id];
        const activity = characterActivityLabel(ch, tools);
        const name = characterDisplayName(ch, role?.label, getProviderLabel(id), sub?.label);
        const external =
          !ch.isSubagent && assignmentReason(role, managedProject) === EXTERNAL_SESSION_LABEL;
        return (
          <div
            key={id}
            className="agent-label absolute -translate-x-1/2 layer-hud"
            style={{ left: screenX, top: screenY, pointerEvents: 'none' }}
            data-testid="agent-overlay"
            data-agent-id={id}
            data-activity={characterActivity(ch)}
          >
            {!hideLabel && (
              <>
                <div className="pixel-panel character-hover-label">
                  <span data-testid="agent-pill">{name}</span>
                  <span> · </span>
                  <span data-testid="agent-activity">{activity}</span>
                  {external && (
                    <span
                      className="external-session-chip"
                      data-testid="agent-assignment-reason"
                      title={EXTERNAL_SESSION_TOOLTIP}
                      style={{ pointerEvents: 'auto' }}
                    >
                      {EXTERNAL_SESSION_LABEL}
                    </span>
                  )}
                </div>
                {!ch.isSubagent && ch.contextTokens > 0 && (
                  <ContextGauge used={ch.contextTokens} limit={ch.maxContextTokens} />
                )}
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
