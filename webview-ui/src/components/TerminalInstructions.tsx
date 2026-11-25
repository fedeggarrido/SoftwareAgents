import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { DOCK_MOBILE_BREAKPOINT_PX } from '../constants.js';

const query = `(max-width: ${DOCK_MOBILE_BREAKPOINT_PX - 1}px), (pointer: coarse)`;
export function TerminalInstructions({ children }: { children: ReactNode }) {
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setFolded(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  if (!folded) return children;
  return (
    <div className="terminal-instructions">
      <p>
        Desde aquí puedes supervisar el proyecto. Para iniciar trabajo, usa una terminal en el
        ordenador del proyecto.
      </p>
      <details>
        <summary>Comando para el ordenador</summary>
        {children}
      </details>
    </div>
  );
}
