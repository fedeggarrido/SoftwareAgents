import { useEffect, useRef, useState } from 'react';

import { OFFICE_EPHEMERAL_WARNING } from '../../../core/src/officeAccess.js';
import { useTextSize } from '../hooks/useTextSize.js';
import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js';
import { officeAccessView, useOfficeAccess } from '../office/accessStore.js';
import { useConnectionStatus } from '../office/connectionStatus.js';
import { useOfficeRecovery } from '../office/recoveryActions.js';
import { isBrowserRuntime } from '../runtime.js';
import { copyOperatorToken, transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Checkbox } from './ui/Checkbox.js';
import { MenuItem } from './ui/MenuItem.js';
import { Modal } from './ui/Modal.js';

interface SettingsModalProps {
  onNewProject: () => void;
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
  /** Hide the Mostrar áreas checkbox entirely when areas are unavailable. */
  showAreasAvailable: boolean;
  /** Browser-native layout export (standalone only; VS Code uses the host save dialog). */
  onExportLayout: () => void;
  /** Browser-native layout import from a chosen file (standalone only). */
  onImportLayout: (file: File) => void;
}

export function SettingsModal({
  onNewProject,
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
  const [textSize, setTextSize] = useTextSize();
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assetDirDraft, setAssetDirDraft] = useState('');
  const [confirmRevocation, setConfirmRevocation] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revocationFailed, setRevocationFailed] = useState(false);
  const officeAccess = useOfficeAccess();
  const access = officeAccessView(officeAccess, !isBrowserRuntime);
  const [copyFeedback, setCopyFeedback] = useState('');
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
    <Modal isOpen={isOpen} onClose={onClose} title="Ajustes" className="settings-dialog">
      <MenuItem onClick={onNewProject}>Nuevo proyecto</MenuItem>
      <p className="p-10" role="status">
        {access.explanation}
      </p>
      {isBrowserRuntime && officeAccess?.persistent === false && (
        <p className="p-10" role="alert">
          {OFFICE_EPHEMERAL_WARNING}
        </p>
      )}
      {isBrowserRuntime && !access.blocked && !access.pending && (
        <details className="p-10">
          <summary>Detalles</summary>
          <p>
            Si un comando pide el token del operador, cópialo aquí y pégalo en la confirmación
            oculta de tu terminal. No lo compartas.
          </p>
          <Button
            onClick={() =>
              void copyOperatorToken().then(
                () => setCopyFeedback('Token copiado.'),
                () =>
                  setCopyFeedback(
                    'No se pudo copiar el token. Comprueba el permiso del portapapeles.',
                  ),
              )
            }
          >
            Copiar token para CLI
          </Button>
          <p role="status">{copyFeedback}</p>
        </details>
      )}
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
                <p role="alert">No se pudo revocar el acceso. Reintenta desde Ajustes.</p>
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
      <fieldset className="text-size-setting">
        <legend>Tamaño del texto</legend>
        <p>Elige cómo leer los paneles en este navegador.</p>
        <Button
          size="sm"
          aria-pressed={textSize === 'normal'}
          onClick={() => setTextSize('normal')}
        >
          Normal
        </Button>
        <Button size="sm" aria-pressed={textSize === 'large'} onClick={() => setTextSize('large')}>
          Grande
        </Button>
      </fieldset>
      {/* The sessions folder opens an OS file manager, unavailable in the browser. */}
      {!isBrowserRuntime && (
        <MenuItem
          onClick={() => {
            transport.send({ type: 'openSessionsFolder' });
            onClose();
          }}
        >
          Abrir carpeta de sesiones
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
        Exportar distribución
        <span className="setting-help">Guarda la distribución de tu oficina en un archivo.</span>
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
        Importar distribución
        <span className="setting-help">Carga una distribución guardada desde un archivo.</span>
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
            placeholder="Ruta absoluta de la carpeta de recursos"
            onChange={(e) => setAssetDirDraft(e.target.value)}
            className="flex-1 min-w-0 text-xs py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const path = assetDirDraft.trim();
              if (!path) return;
              transport.send({ type: 'addExternalAssetDirectory', path });
              setAssetDirDraft('');
            }}
            className="shrink-0"
          >
            Añadir
          </Button>
        </div>
      ) : (
        <MenuItem
          onClick={() => {
            transport.send({ type: 'addExternalAssetDirectory' });
            onClose();
          }}
        >
          Añadir carpeta de recursos
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
        label="Avisos sonoros"
        help="Suena un aviso cuando un agente necesita tu atención."
        checked={soundLocal}
        onChange={() => {
          const newVal = !isSoundEnabled();
          setSoundEnabled(newVal);
          setSoundLocal(newVal);
          transport.send({ type: 'setSoundEnabled', enabled: newVal });
        }}
      />
      <Checkbox
        label="Observar todas las sesiones"
        help="Incluye las sesiones que abres fuera de esta oficina."
        checked={watchAllSessions}
        onChange={onToggleWatchAllSessions}
      />
      <Checkbox
        label="Detección instantánea (hooks)"
        help="Recibe la actividad de Claude Code en cuanto ocurre."
        checked={hooksInstalled}
        onChange={onToggleHooksEnabled}
      />
      <Checkbox
        label="Mostrar siempre las etiquetas"
        help="Muestra el nombre y el estado sin pasar el cursor."
        checked={alwaysShowOverlay}
        onChange={onToggleAlwaysShowOverlay}
      />
      {/* Headless agents are the office's only terminal-less citizens in VS Code.
          Standalone has no terminals at all, so nothing there would ever ghost. */}
      {!isBrowserRuntime && (
        <Checkbox
          label="Atenuar sesiones sin terminal"
          help="Distingue las sesiones que no tienen una terminal para abrir."
          checked={ghostHeadlessAgents}
          onChange={onToggleGhostHeadlessAgents}
        />
      )}
      {showAreasAvailable && (
        <Checkbox
          label="Mostrar áreas"
          help="Resalta las zonas de la oficina y sus nombres."
          checked={showAreas}
          onChange={onToggleShowAreas}
        />
      )}
      <Checkbox
        label="Vista de diagnóstico"
        help="Muestra datos técnicos para investigar problemas de actividad."
        checked={isDebugMode}
        onChange={onToggleDebugMode}
      />
    </Modal>
  );
}
