import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import * as http from 'http';

import {
  OPERATOR_PROOF_CONTEXT,
  OPERATOR_PROOF_MAX_BODY_CHARS,
  OPERATOR_PROOF_NONCE_BYTES,
  OPERATOR_PROOF_PATH,
  OPERATOR_PROOF_TIMEOUT_MS,
} from './constants.js';
import type { ServerTarget } from './serverConfig.js';

export function serverProof(token: string, nonce: string, pid: number): string {
  return createHmac('sha256', token)
    .update(`${OPERATOR_PROOF_CONTEXT}${nonce}:${pid}`)
    .digest('hex');
}

/** Never send the capability, follow redirects or contact discovery's advertised host. */
export function verifyServerProof(
  target: ServerTarget,
  timeoutMs = OPERATOR_PROOF_TIMEOUT_MS,
): Promise<boolean> {
  const nonce = randomBytes(OPERATOR_PROOF_NONCE_BYTES).toString('hex');
  const expected = Buffer.from(serverProof(target.token, nonce, target.pid), 'hex');
  return new Promise((resolve) => {
    let settled = false;
    let request: http.ClientRequest | undefined;
    const finish = (valid: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(valid);
      request?.destroy();
    };
    const deadline = setTimeout(() => finish(false), timeoutMs);
    try {
      request = http.get(
        {
          hostname: '127.0.0.1',
          port: target.port,
          path: `${OPERATOR_PROOF_PATH}?nonce=${nonce}`,
          agent: false,
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            if (body.length + chunk.length > OPERATOR_PROOF_MAX_BODY_CHARS) return finish(false);
            body += chunk;
          });
          response.on('end', () => {
            try {
              const proof: unknown = JSON.parse(body);
              if (
                response.statusCode !== 200 ||
                proof === null ||
                typeof proof !== 'object' ||
                !('proof' in proof) ||
                typeof proof.proof !== 'string' ||
                proof.proof.length !== expected.length * 2 ||
                !/^[a-f0-9]+$/.test(proof.proof)
              )
                return finish(false);
              finish(timingSafeEqual(Buffer.from(proof.proof, 'hex'), expected));
            } catch {
              finish(false);
            }
          });
          response.on('error', () => finish(false));
          response.on('aborted', () => finish(false));
        },
      );
      request.on('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}
