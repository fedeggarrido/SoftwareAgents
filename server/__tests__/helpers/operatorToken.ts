import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import { vi } from 'vitest';

import { OPERATOR_PROOF_NONCE_BYTES, OPERATOR_PROOF_PATH } from '../../src/constants.js';
import * as proof from '../../src/serverProof.js';

const token = 'test-operator-capability';

/** Only call after HOME is isolated. No real server, network or user discovery. */
export function operatorToken(home: string) {
  // Command suites isolate authentication; dedicated ingress/proof suites use real HTTP.
  vi.spyOn(proof, 'verifyServerProof').mockResolvedValue(true);
  writeDiscovery(home, 43210);
}

/** Real loopback proof for asynchronous CLI subprocesses with an isolated home. */
export async function operatorTokenServer(home: string) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    const nonce = url.searchParams.get('nonce');
    if (
      url.pathname !== OPERATOR_PROOF_PATH ||
      !nonce ||
      !new RegExp(`^[a-f0-9]{${OPERATOR_PROOF_NONCE_BYTES * 2}}$`).test(nonce)
    ) {
      response.writeHead(400).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ proof: proof.serverProof(token, nonce, process.pid) }));
  });
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    writeDiscovery(home, (server.address() as AddressInfo).port);
  } catch (error) {
    await close();
    throw error;
  }
  return { close };
}

function writeDiscovery(home: string, port: number) {
  const directory = path.join(home, '.pixel-agents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'server.json'),
    JSON.stringify({ pid: process.pid, port, token }),
  );
  vi.stubEnv('PIXEL_AGENTS_OPERATOR_TOKEN', token);
}
