import { useRef, useState } from 'react';

import { COMMAND_COPY_FEEDBACK, COMMAND_COPY_LABEL, copyCommand } from '../office/commandCopy.js';
import { Button } from './ui/Button.js';

export function IdeaCommand({ command, checkoutName }: { command: string; checkoutName?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [feedback, setFeedback] = useState('');
  const copy = async () => {
    const outcome = await copyCommand(
      command,
      (text) => navigator.clipboard.writeText(text),
      () => {
        if (!input.current) throw new Error('Command unavailable');
        input.current.focus();
        input.current.select();
      },
    );
    setFeedback(COMMAND_COPY_FEEDBACK[outcome]);
  };
  return (
    <div className="idea-command flex flex-col gap-8 min-w-0">
      <p>Para continuar, ejecuta este comando en tu terminal.</p>
      <p>
        «Este checkout» es la carpeta del repositorio vinculada a esta oficina
        {checkoutName ? (
          <>
            : <strong>{checkoutName}</strong>
          </>
        ) : (
          ''
        )}
        .
      </p>
      <input
        ref={input}
        aria-label="Comando para continuar la idea"
        className="idea-command-text bg-bg-dark text-text border-2 border-border p-8 w-full"
        readOnly
        value={command}
        spellCheck={false}
      />
      <Button size="sm" onClick={() => void copy()}>
        {COMMAND_COPY_LABEL}
      </Button>
      <p role="status" aria-live="polite">
        {feedback}
      </p>
      <p>
        El comando pedirá el token del operador: es el valor de «token» en la URL que pixel-agents
        mostró al iniciarse en tu terminal.
      </p>
    </div>
  );
}
