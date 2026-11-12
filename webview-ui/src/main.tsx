import './index.css';
import './components/NewIdeaDialog.css';
import './components/ProjectSummaryPanel.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';
import { UI_LAYERS } from './constants.js';
import { initialiseTextSize } from './hooks/useTextSize.js';
import { isBrowserRuntime } from './runtime';

async function main() {
  for (const [layer, value] of Object.entries(UI_LAYERS)) {
    document.documentElement.style.setProperty(`--z-${layer}`, String(value));
  }
  initialiseTextSize();
  // browserMock is for Vite dev mode only (UI prototyping without a server).
  // In standalone server mode, assets are loaded server-side and sent over WebSocket.
  if (isBrowserRuntime && import.meta.env.DEV) {
    const { initBrowserMock } = await import('./browserMock.js');
    await initBrowserMock();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

main().catch(console.error);
