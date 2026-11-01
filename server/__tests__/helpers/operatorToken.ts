import * as fs from 'fs';
import * as path from 'path';
import { vi } from 'vitest';

/** Only call after HOME is isolated. No real server, network or user discovery. */
export function operatorToken(home: string) {
  const token = 'test-operator-capability';
  const directory = path.join(home, '.pixel-agents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'server.json'),
    JSON.stringify({ pid: process.pid, port: 43210, token }),
  );
  vi.stubEnv('PIXEL_AGENTS_OPERATOR_TOKEN', token);
}
