import { useState } from 'react';

import type { useEditorActions } from '../hooks/useEditorActions.js';
import type { EditorState } from '../office/editor/editorState.js';
import { Button } from './ui/Button.js';

interface EditActionBarProps {
  editor: ReturnType<typeof useEditorActions>;
  editorState: EditorState;
}

export function EditActionBar({ editor, editorState: es }: EditActionBarProps) {
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const undoDisabled = es.undoStack.length === 0;
  const redoDisabled = es.redoStack.length === 0;

  return (
    <div className="absolute top-8 left-1/2 -translate-x-1/2 layer-hud flex gap-4 items-center pixel-panel p-4">
      <Button
        variant="secondary"
        disabled={undoDisabled}
        size="md"
        onClick={undoDisabled ? undefined : editor.handleUndo}
        title="Deshacer (Ctrl+Z)"
      >
        Deshacer
      </Button>
      <Button
        variant="secondary"
        disabled={redoDisabled}
        size="md"
        onClick={redoDisabled ? undefined : editor.handleRedo}
        title="Rehacer (Ctrl+Y)"
      >
        Rehacer
      </Button>
      <Button
        variant="secondary"
        size="md"
        onClick={editor.handleSave}
        title="Guardar distribución"
      >
        Guardar
      </Button>
      {!showResetConfirm ? (
        <Button
          variant="secondary"
          size="md"
          onClick={() => setShowResetConfirm(true)}
          title="Volver a la distribución guardada"
        >
          Restablecer
        </Button>
      ) : (
        <div className="flex gap-4 items-center">
          <span className="text-base text-reset-text">¿Restablecer?</span>
          <Button
            variant="secondary"
            size="md"
            className="bg-danger text-white"
            onClick={() => {
              setShowResetConfirm(false);
              editor.handleReset();
            }}
          >
            Sí
          </Button>
          <Button variant="secondary" size="md" onClick={() => setShowResetConfirm(false)}>
            No
          </Button>
        </div>
      )}
    </div>
  );
}
