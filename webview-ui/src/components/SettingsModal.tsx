import { useEffect, useRef, useState } from 'react';

import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js';
import { officeAccessView, useOfficeAccess } from '../office/accessStore.js';
import { useConnectionStatus } from '../office/connectionStatus.js';
import { useOfficeRecovery } from '../office/recoveryActions.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Checkbox } from './ui/Checkbox.js';
import { MenuItem } from './ui/MenuItem.js';
import { Modal } from './ui/Modal.js';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDebugMode: boolean;
  onToggleDebugMode: () => void;
  alwaysShowOverlay: boolean;
  onToggleAlwaysShowOverlay: () => void;
  /** Whether headless agents (adopted, no terminal to focus) render translucent. */
  ghostHeadlessAgents: boolean;
  onToggleGhostHeadlessAgents: () => void;
  externalAssetDirectories: string[];
  watchAllSessions: boolean;
  onToggleWatchAllSessions: () => void;
  /** ACTUAL install state (the hooksStatus message), not the hooksEnabled
   *  preference. The preference defaults to true while first-run consent is
   *  still pending, so binding the checkbox to it renders "on" over an empty
   *  ~/.claude/settings.json. */
  hooksInstalled: boolean;
  onToggleHooksEnabled: () => void;
  /** Whether the areas overlay is rendered outside of the Areas edit tool. */
  showAreas: boolean;
  onToggleShowAreas: () => void;
  /** Hide the Show Areas checkbox entirely when areas are unavailable. */
  showAreasAvailable: boolean;
  /** Browser-native layout export (standalone only; VS Code uses the host save dialog). */
  onExportLayout: () => void;
  /** Browser-native layout import from a chosen file (standalone only). */
  onImportLayout: (file: File) => void;
}

export function SettingsModal({
  isOpen,
  onClose,
  isDebugMode,
  onToggleDebugMode,
  alwaysShowOverlay,
  onToggleAlwaysShowOverlay,
  ghostHeadlessAgents,
  onToggleGhostHeadlessAgents,
  externalAssetDirectories,
  watchAllSessions,
  onToggleWatchAllSessions,
  hooksInstalled,
  onToggleHooksEnabled,
  showAreas,
  onToggleShowAreas,
  showAreasAvailable,
  onExportLayout,
  onImportLayout,
}: SettingsModalProps) {
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assetDirDraft, setAssetDirDraft] = useState('');
  const [confirmRevocation, setConfirmRevocation] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revocationFailed, setRevocationFailed] = useState(false);
  const access = officeAccessView(useOfficeAccess(), !isBrowserRuntime);
  const connection = useConnectionStatus();
  const recovery = useOfficeRecovery();
  useEffect(
    () =>
      transport.onMessage((message) => {
        if (message.type === 'officeTokenRotationFailed') {
          setRevoking(false);
          setRevocationFailed(true);
        }
      }),
    [],
  );
  useEffect(() => {
    if (revoking && connection.state !== 'connected') {
      setRevoking(false);
      setConfirmRevocation(false);
      onClose();
    }
  }, [revoking, connection.state, onClose]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Settings">
      <p className="p-10" role="status">
        {access.explanation}
      </p>
      {isBrowserRuntime && (
        <>
          <MenuItem
            onClick={() => {
              onClose();
              recovery.prepareProject();
            }}
          >
            Preparar proyecto
          </MenuItem>
          {!access.pending && !access.blocked && connection.state === 'connected' && (
            <MenuItem
              onClick={() => {
                setRevocationFailed(false);
                setConfirmRevocation(true);
              }}
            >
              Revocar acceso de esta pestaña
            </MenuItem>
          )}
          {confirmRevocation && (
            <div
              className="p-10 flex flex-col gap-8"
              role="group"
              aria-label="Confirmar revocación"
            >
              <p>
                Se revocará el acceso de todas las pestañas abiertas. Abre Pixel Agents de nuevo
                para volver a entrar.
              </p>
              {revocationFailed && (
                <p role="alert">No se pudo revocar el acceso. Reintenta desde Settings.</p>
              )}
              <Button
                disabled={
                  revoking || access.blocked || access.pending || connection.state !== 'connected'
                }
                onClick={() => {
                  setRevocationFailed(false);
                  setRevoking(true);
                  try {
                    transport.send({ type: 'rotateOfficeToken' });
                  } catch {
                    setRevoking(false);
                    setRevocationFailed(true);
                  }
                }}
              >
                {revoking
                  ? 'Revocando…'
                  : revocationFailed
                    ? 'Reintentar'
                    : 'Revocar todas las pestañas'}
              </Button>
              <Button onClick={() => setConfirmRevocation(false)}>Cancelar</Button>
            </div>
          )}
        </>
      )}
      {/* Open Sessions Folder opens an OS file manager — impossible in the browser. */}
      {!isBrowserRuntime && (
        <MenuItem
          onClick={() => {
            transport.send({ type: 'openSessionsFolder' });
            onClose();
          }}
        >
          Open Sessions Folder
        </MenuItem>
      )}
      <MenuItem
        onClick={() => {
          if (isBrowserRuntime) {
            onExportLayout();
          } else {
            transport.send({ type: 'exportLayout' });
          }
          onClose();
        }}
      >
        Export Layout
      </MenuItem>
      <MenuItem
        onClick={() => {
          if (isBrowserRuntime) {
            // Open the native file picker; the import is applied in onChange below.
            fileInputRef.current?.click();
          } else {
            transport.send({ type: 'importLayout' });
            onClose();
          }
        }}
      >
        Import Layout
      </MenuItem>
      {isBrowserRuntime && (
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset the value so re-selecting the same file fires change again.
            e.target.value = '';
            if (file) {
              onImportLayout(file);
              onClose();
            }
          }}
        />
      )}
      {/* Browser has no native directory picker, so accept a typed absolute path. */}
      {isBrowserRuntime ? (
        <div className="flex items-center gap-4 py-4 px-10">
          <input
            type="text"
            value={assetDirDraft}
            placeholder="Absolute asset directory path"
            onChange={(e) => setAssetDirDraft(e.target.value)}
            className="flex-1 min-w-0 text-xs py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
          />
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              const path = assetDirDraft.trim();
              if (!path) return;
              transport.send({ type: 'addExternalAssetDirectory', path });
              setAssetDirDraft('');
            }}
            className="shrink-0"
          >
            Add
          </Button>
        </div>
      ) : (
        <MenuItem
          onClick={() => {
            transport.send({ type: 'addExternalAssetDirectory' });
            onClose();
          }}
        >
          Add Asset Directory
        </MenuItem>
      )}
      {externalAssetDirectories.map((dir) => (
        <div key={dir} className="flex items-center justify-between py-4 px-10 gap-8">
          <span
            className="text-xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap"
            title={dir}
          >
            {dir.split(/[/\\]/).pop() ?? dir}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => transport.send({ type: 'removeExternalAssetDirectory', path: dir })}
            className="shrink-0"
          >
            x
          </Button>
        </div>
      ))}
      <Checkbox
        label="Sound Notifications"
        checked={soundLocal}
        onChange={() => {
          const newVal = !isSoundEnabled();
          setSoundEnabled(newVal);
          setSoundLocal(newVal);
          transport.send({ type: 'setSoundEnabled', enabled: newVal });
        }}
      />
      <Checkbox
        label="Watch All Sessions"
        checked={watchAllSessions}
        onChange={onToggleWatchAllSessions}
      />
      <Checkbox
        label="Detección instantánea (hooks)"
        checked={hooksInstalled}
        onChange={onToggleHooksEnabled}
      />
      <Checkbox
        label="Always Show Labels"
        checked={alwaysShowOverlay}
        onChange={onToggleAlwaysShowOverlay}
      />
      {/* Headless agents are the office's only terminal-less citizens in VS Code.
          Standalone has no terminals at all, so nothing there would ever ghost. */}
      {!isBrowserRuntime && (
        <Checkbox
          label="Display Headless as Ghosts"
          checked={ghostHeadlessAgents}
          onChange={onToggleGhostHeadlessAgents}
        />
      )}
      {showAreasAvailable && (
        <Checkbox label="Show Areas" checked={showAreas} onChange={onToggleShowAreas} />
      )}
      <Checkbox label="Debug View" checked={isDebugMode} onChange={onToggleDebugMode} />
    </Modal>
  );
}
