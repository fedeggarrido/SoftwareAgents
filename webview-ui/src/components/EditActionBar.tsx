import { useState } from 'react';

import type { useEditorActions } from '../hooks/useEditorActions.js';
import { es } from '../i18n/es.js';
import type { EditorState } from '../office/editor/editorState.js';
import { Button } from './ui/Button.js';

interface EditActionBarProps {
  editor: ReturnType<typeof useEditorActions>;
  editorState: EditorState;
}

export function EditActionBar({ editor, editorState }: EditActionBarProps) {
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const undoDisabled = editorState.undoStack.length === 0;
  const redoDisabled = editorState.redoStack.length === 0;

  return (
    <div className="flex flex-wrap max-sm:basis-full gap-4 items-center px-8">
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
        title={es.office.saveDesign}
      >
        Guardar
      </Button>
      {!showResetConfirm ? (
        <Button
          variant="secondary"
          size="md"
          onClick={() => setShowResetConfirm(true)}
          title={es.office.resetDesign}
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
