import { useEffect, useRef, useState } from 'react';

import { OFFICE_EPHEMERAL_WARNING } from '../../../core/src/officeAccess.js';
import { useTextSize } from '../hooks/useTextSize.js';
import { es } from '../i18n/es.js';
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
    <Modal isOpen={isOpen} onClose={onClose} title={es.settings.title} className="settings-dialog">
      <section aria-labelledby="settings-general">
        <h2 id="settings-general">{es.settings.general}</h2>
        <MenuItem onClick={onNewProject} help={es.settings.newProjectHelp}>
          {es.settings.newProject}
        </MenuItem>
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
            <summary>{es.settings.details}</summary>
            <p id="settings-token-help">{es.settings.operatorTokenHelp}</p>
            <Button
              aria-describedby="settings-token-help"
              onClick={() =>
                void copyOperatorToken().then(
                  () => setCopyFeedback(es.settings.tokenCopied),
                  () => setCopyFeedback(es.settings.tokenCopyFailed),
                )
              }
            >
              {es.settings.copyToken}
            </Button>
            <p role="status">{copyFeedback}</p>
          </details>
        )}
        {isBrowserRuntime && (
          <>
            <MenuItem
              help={es.settings.prepareProjectHelp}
              onClick={() => {
                onClose();
                recovery.prepareProject();
              }}
            >
              {es.settings.prepareProject}
            </MenuItem>
            {!access.pending && !access.blocked && connection.state === 'connected' && (
              <MenuItem
                help={es.settings.revokeHelp}
                onClick={() => {
                  setRevocationFailed(false);
                  setConfirmRevocation(true);
                }}
              >
                {es.settings.revokeTab}
              </MenuItem>
            )}
            {confirmRevocation && (
              <div
                className="p-10 flex flex-col gap-8"
                role="group"
                aria-label={es.settings.revokeConfirm}
              >
                <p>{es.settings.revokeWarning}</p>
                {revocationFailed && <p role="alert">{es.settings.revokeFailed}</p>}
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
                    ? es.settings.revoking
                    : revocationFailed
                      ? es.settings.retry
                      : es.settings.revokeAll}
                </Button>
                <Button onClick={() => setConfirmRevocation(false)}>{es.settings.cancel}</Button>
              </div>
            )}
          </>
        )}
        <fieldset className="text-size-setting" aria-describedby="settings-text-size-help">
          <legend>{es.settings.textSize}</legend>
          <p id="settings-text-size-help">{es.settings.textSizeHelp}</p>
          <Button
            size="sm"
            aria-describedby="settings-text-size-help"
            aria-pressed={textSize === 'normal'}
            onClick={() => setTextSize('normal')}
          >
            {es.settings.normal}
          </Button>
          <Button
            size="sm"
            aria-describedby="settings-text-size-help"
            aria-pressed={textSize === 'large'}
            onClick={() => setTextSize('large')}
          >
            {es.settings.large}
          </Button>
        </fieldset>
        <Checkbox
          label={es.settings.sound}
          help={es.settings.soundHelp}
          checked={soundLocal}
          onChange={() => {
            const newVal = !isSoundEnabled();
            setSoundEnabled(newVal);
            setSoundLocal(newVal);
            transport.send({ type: 'setSoundEnabled', enabled: newVal });
          }}
        />
      </section>
      <section aria-labelledby="settings-office">
        <h2 id="settings-office">{es.settings.office}</h2>
        {/* The sessions folder opens an OS file manager, unavailable in the browser. */}
        {!isBrowserRuntime && (
          <MenuItem
            help={es.settings.openSessionsHelp}
            onClick={() => {
              transport.send({ type: 'openSessionsFolder' });
              onClose();
            }}
          >
            {es.settings.openSessions}
          </MenuItem>
        )}
        <MenuItem
          help={es.office.exportHelp}
          onClick={() => {
            if (isBrowserRuntime) {
              onExportLayout();
            } else {
              transport.send({ type: 'exportLayout' });
            }
            onClose();
          }}
        >
          {es.office.exportDesign}
        </MenuItem>
        <MenuItem
          help={es.office.importHelp}
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
          {es.office.importDesign}
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
        <Checkbox
          label={es.settings.labels}
          help={es.settings.labelsHelp}
          checked={alwaysShowOverlay}
          onChange={onToggleAlwaysShowOverlay}
        />
        {/* Headless agents are the office's only terminal-less citizens in VS Code.
          Standalone has no terminals at all, so nothing there would ever ghost. */}
        {!isBrowserRuntime && (
          <Checkbox
            label={es.settings.headless}
            help={es.settings.headlessHelp}
            checked={ghostHeadlessAgents}
            onChange={onToggleGhostHeadlessAgents}
          />
        )}
        {showAreasAvailable && (
          <Checkbox
            label={es.settings.areas}
            help={es.settings.areasHelp}
            checked={showAreas}
            onChange={onToggleShowAreas}
          />
        )}
      </section>
      <section aria-labelledby="settings-advanced">
        <h2 id="settings-advanced">{es.settings.advanced}</h2>
        <p id="settings-assets-help" className="setting-help p-10">
          {es.settings.assetsHelp}
        </p>
        {isBrowserRuntime ? (
          <div className="flex items-center gap-4 py-4 px-10">
            <input
              type="text"
              aria-label={es.settings.addAssets}
              aria-describedby="settings-assets-help"
              value={assetDirDraft}
              placeholder={es.settings.assetDirectoryPlaceholder}
              onChange={(e) => setAssetDirDraft(e.target.value)}
              className="flex-1 min-w-0 text-base py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
            />
            <Button
              aria-describedby="settings-assets-help"
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
              {es.settings.add}
            </Button>
          </div>
        ) : (
          <MenuItem
            help={es.settings.assetsHelp}
            onClick={() => {
              transport.send({ type: 'addExternalAssetDirectory' });
              onClose();
            }}
          >
            {es.settings.addAssets}
          </MenuItem>
        )}
        {externalAssetDirectories.map((dir) => (
          <div key={dir} className="flex items-center justify-between py-4 px-10 gap-8">
            <span
              className="text-base text-text-muted overflow-hidden text-ellipsis whitespace-nowrap"
              title={dir}
            >
              {dir.split(/[/\\]/).pop() ?? dir}
            </span>
            <Button
              aria-label={es.settings.removeAssets(dir)}
              aria-describedby="settings-assets-help"
              variant="ghost"
              size="sm"
              onClick={() => transport.send({ type: 'removeExternalAssetDirectory', path: dir })}
              className="shrink-0"
            >
              {es.settings.remove}
            </Button>
          </div>
        ))}
        <Checkbox
          label={es.settings.watchSessions}
          help={es.settings.watchSessionsHelp}
          checked={watchAllSessions}
          onChange={onToggleWatchAllSessions}
        />
        <Checkbox
          label={es.settings.hooks}
          help={es.settings.hooksHelp}
          checked={hooksInstalled}
          onChange={onToggleHooksEnabled}
        />
        <Checkbox
          label={es.settings.debug}
          help={es.settings.debugHelp}
          checked={isDebugMode}
          onChange={onToggleDebugMode}
        />
      </section>
    </Modal>
  );
}
