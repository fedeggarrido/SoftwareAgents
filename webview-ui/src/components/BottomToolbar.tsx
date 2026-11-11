import { useEffect, useRef, useState } from 'react';

import {
  DOCK_MOBILE_BREAKPOINT_PX,
  DOCK_SHEET_Z_INDEX,
  PR_DISPLAY_REFRESH_MS,
} from '../constants.js';
import { useDismissibleLayer } from '../hooks/useDismissibleLayer.js';
import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js';
import { useBoard } from '../office/boardStore.js';
import { decisionsHudView } from '../office/decisionsHudView.js';
import type { PanelTab } from '../office/panelWindowState.js';
import { pullRequestDockSummary } from '../office/prStatusView.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { DockIcon } from './DockIcon.js';
import { Dropdown, DropdownItem } from './ui/Dropdown.js';

interface BottomToolbarProps {
  isEditMode: boolean;
  onOpenClaude: () => void;
  onToggleEditMode: () => void;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
  activePanel: PanelTab | null;
  onTogglePanel: (tab: PanelTab) => void;
  onNewIdea: () => void;
  workspaceFolders: WorkspaceFolder[];
}

export function BottomToolbar({
  isEditMode,
  onOpenClaude,
  onToggleEditMode,
  isSettingsOpen,
  onToggleSettings,
  activePanel,
  onTogglePanel,
  onNewIdea,
  workspaceFolders,
}: BottomToolbarProps) {
  const board = useBoard();
  const [prNow, setPrNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setPrNow(Date.now()), PR_DISPLAY_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const prs = pullRequestDockSummary(board?.items ?? [], prNow);
  const pending = decisionsHudView(board ?? {}).open;
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < DOCK_MOBILE_BREAKPOINT_PX,
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const firstSheetButtonRef = useRef<HTMLButtonElement>(null);
  const moreVisible = moreOpen && mobile && !isEditMode;
  useDismissibleLayer(
    moreVisible,
    () => setMoreOpen(false),
    DOCK_SHEET_Z_INDEX,
    firstSheetButtonRef,
    true,
    sheetRef,
  );
  useEffect(() => {
    const resize = () => {
      setMobile(window.innerWidth < DOCK_MOBILE_BREAKPOINT_PX);
      setMoreOpen(false);
      setIsFolderPickerOpen(false);
      setIsBypassMenuOpen(false);
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!moreVisible) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (
        !sheetRef.current?.contains(event.target) &&
        !(
          event.target instanceof Element &&
          event.target.closest('[aria-controls="dock-more-sheet"]')
        )
      ) {
        setMoreOpen(false);
      }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [moreVisible]);
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const [isBypassMenuOpen, setIsBypassMenuOpen] = useState(false);
  const folderPickerRef = useRef<HTMLDivElement>(null);
  const pendingBypassRef = useRef(false);
  // Close folder picker / bypass menu on outside click
  useEffect(() => {
    if (!isFolderPickerOpen && !isBypassMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node)) {
        setIsFolderPickerOpen(false);
        setIsBypassMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isFolderPickerOpen, isBypassMenuOpen]);

  const hasMultipleFolders = workspaceFolders.length > 1;

  const handleAgentClick = () => {
    setIsBypassMenuOpen(false);
    pendingBypassRef.current = false;
    if (hasMultipleFolders) {
      setIsFolderPickerOpen((v) => !v);
    } else {
      setMoreOpen(false);
      onOpenClaude();
    }
  };

  const handleAgentHover = () => {
    if (!isFolderPickerOpen) {
      setIsBypassMenuOpen(true);
    }
  };

  const handleAgentLeave = () => {
    if (!isFolderPickerOpen) {
      setIsBypassMenuOpen(false);
    }
  };

  const handleFolderSelect = (folder: WorkspaceFolder) => {
    setIsFolderPickerOpen(false);
    setMoreOpen(false);
    const bypassPermissions = pendingBypassRef.current;
    pendingBypassRef.current = false;
    transport.send({ type: 'launchAgent', folderPath: folder.path, bypassPermissions });
  };

  const handleBypassSelect = (bypassPermissions: boolean) => {
    setIsBypassMenuOpen(false);
    if (hasMultipleFolders) {
      pendingBypassRef.current = bypassPermissions;
      setIsFolderPickerOpen(true);
    } else {
      setMoreOpen(false);
      transport.send({ type: 'launchAgent', bypassPermissions });
    }
  };

  const panels = [
    { id: 'backlog', label: 'Trabajo', title: 'Backlog de la empresa de agentes' },
    { id: 'decisions', label: 'Decisiones', title: 'Decisiones del propietario' },
    { id: 'features', label: 'Funcionalidades', title: 'Features de solo lectura' },
    { id: 'audit', label: 'Auditoría', title: 'Auditoría de solo lectura' },
  ] as const;
  const selectPanel = (tab: PanelTab) => {
    setMoreOpen(false);
    onTogglePanel(tab);
  };
  const panelButton = (entry: (typeof panels)[number]) => (
    <button
      key={entry.id}
      type="button"
      className="dock-button dock-segment"
      aria-label={entry.label}
      aria-pressed={activePanel === entry.id}
      aria-controls="office-panel-content"
      aria-describedby={
        entry.id === 'decisions' && pending > 0 ? 'dock-decisions-pending' : undefined
      }
      title={
        entry.id === 'backlog' && prs
          ? `${entry.title}\nEstado de PR: ${prs.label}\n${prs.title}`
          : entry.title
      }
      onClick={() => selectPanel(entry.id)}
    >
      <span className="dock-symbol">
        <DockIcon name={entry.id} />
        {entry.id === 'decisions' && pending > 0 && (
          <span
            id="dock-decisions-pending"
            className="dock-badge"
            role="status"
            aria-label={`${pending} ${pending === 1 ? 'decisión pendiente' : 'decisiones pendientes'}`}
          >
            <DockIcon name="attention" />
            {pending}
          </span>
        )}
      </span>
      <span>{entry.label}</span>
    </button>
  );
  const settingsButton = (
    <button
      type="button"
      className="dock-button dock-icon-button"
      title="Ajustes"
      aria-label="Ajustes"
      aria-pressed={isSettingsOpen}
      onClick={() => {
        setMoreOpen(false);
        onToggleSettings();
      }}
    >
      <DockIcon name="settings" />
      {moreVisible && <span>Ajustes</span>}
    </button>
  );
  const editButton = (
    <button
      type="button"
      className="dock-button dock-icon-button"
      title={isEditMode ? 'Salir de edición' : 'Editar oficina'}
      aria-label={isEditMode ? 'Salir de edición' : 'Editar oficina'}
      aria-pressed={isEditMode}
      onClick={() => {
        setMoreOpen(false);
        setIsFolderPickerOpen(false);
        setIsBypassMenuOpen(false);
        onToggleEditMode();
      }}
    >
      <DockIcon name="edit" />
      {(isEditMode || moreVisible) && (
        <span>{isEditMode ? 'Salir de edición' : 'Editar oficina'}</span>
      )}
    </button>
  );
  const agentControl = (
    <>
      {/* VS Code retains its terminal launcher as a secondary control. */}
      {!isBrowserRuntime && (
        <div
          ref={folderPickerRef}
          className="dock-agent relative"
          onMouseEnter={handleAgentHover}
          onMouseLeave={handleAgentLeave}
        >
          <button
            type="button"
            onClick={handleAgentClick}
            className="dock-button dock-icon-button"
            title="Abrir agente"
            aria-label="Abrir agente"
          >
            <DockIcon name="agent" />
            {moreVisible && <span>Abrir agente</span>}
          </button>
          <Dropdown isOpen={isBypassMenuOpen}>
            <DropdownItem onClick={() => handleBypassSelect(true)}>
              Omitir permisos <span className="text-2xs text-warning">⚠</span>
            </DropdownItem>
          </Dropdown>
          <Dropdown isOpen={isFolderPickerOpen} className="min-w-128">
            {workspaceFolders.map((folder) => (
              <DropdownItem
                key={folder.path}
                onClick={() => handleFolderSelect(folder)}
                className="text-base"
              >
                {folder.name}
              </DropdownItem>
            ))}
          </Dropdown>
        </div>
      )}
    </>
  );

  return (
    <nav
      className={`bottom-toolbar pixel-panel ${mobile ? 'dock-mobile' : ''} ${isEditMode ? 'dock-editing' : ''}`}
      aria-label="Controles de la oficina"
    >
      {isEditMode ? (
        <>
          {editButton}
          {/* Agents can still be opened while arranging seats and areas, as before. */}
          {agentControl}
          {settingsButton}
        </>
      ) : (
        <>
          <button
            type="button"
            className="dock-button dock-primary"
            onClick={onNewIdea}
            aria-label="Nueva idea"
            title="Nueva idea"
          >
            <DockIcon name="idea" />
            <span>{mobile ? 'Idea' : 'Nueva idea'}</span>
          </button>
          <div className="dock-panels" role="group" aria-label="Paneles">
            {(mobile ? panels.slice(0, 2) : panels).map(panelButton)}
          </div>
          {mobile ? (
            <button
              type="button"
              className="dock-button"
              aria-label="Más"
              title="Más"
              aria-expanded={moreVisible}
              aria-controls="dock-more-sheet"
              onClick={() => setMoreOpen((open) => !open)}
            >
              <DockIcon name="more" />
              <span>Más</span>
            </button>
          ) : (
            <div className="dock-secondary" role="group" aria-label="Oficina y ajustes">
              {agentControl}
              {editButton}
              {settingsButton}
            </div>
          )}
        </>
      )}
      {moreVisible && (
        <div
          id="dock-more-sheet"
          className="dock-sheet pixel-panel"
          ref={sheetRef}
          role="dialog"
          aria-modal="true"
          aria-label="Más opciones"
        >
          <button
            type="button"
            className="dock-button dock-sheet-close"
            ref={firstSheetButtonRef}
            aria-label="Cerrar más opciones"
            onClick={() => setMoreOpen(false)}
          >
            Cerrar
          </button>
          {panels.slice(2).map(panelButton)}
          {agentControl}
          {editButton}
          {settingsButton}
        </div>
      )}
    </nav>
  );
}
