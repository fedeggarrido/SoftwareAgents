import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';

import * as proof from '../../src/serverProof.js';

const account = os.userInfo();

/** Only call after HOME is isolated. No real server, network or user discovery. */
export function operatorToken(home: string) {
  vi.spyOn(os, 'userInfo').mockReturnValue({ ...account, homedir: home });
  // Command suites isolate authentication; dedicated ingress/proof suites use real HTTP.
  vi.spyOn(proof, 'verifyServerProof').mockResolvedValue(true);
  const token = 'test-operator-capability';
  const directory = path.join(home, '.pixel-agents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'server.json'),
    JSON.stringify({ pid: process.pid, port: 43210, token }),
  );
  vi.stubEnv('PIXEL_AGENTS_OPERATOR_TOKEN', token);
}
