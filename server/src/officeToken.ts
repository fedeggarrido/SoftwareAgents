import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { AuditLog } from './auditLog.js';
import {
  MAX_PORT,
  MIN_PORT,
  OFFICE_CREDENTIAL_FILE,
  PRIVATE_COMMAND_TIMEOUT_MS,
  PRIVATE_FILE_MODE,
} from './constants.js';
import { discoveryEntryPath, withDiscoveryLock, writeDiscoveryRecord } from './discoveryRecords.js';

interface OfficeCredential {
  token: string;
  port?: number;
}

/** Remove inherited grants before writing a secret into the exclusive temporary. */
function protectCredential(file: string): void {
  if (process.platform !== 'win32') {
    fs.chmodSync(file, PRIVATE_FILE_MODE);
    return;
  }
  const options = { windowsHide: true, timeout: PRIVATE_COMMAND_TIMEOUT_MS };
  let identity: string;
  const systemDir = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  try {
    identity = execFileSync(
      path.join(systemDir, 'whoami.exe'),
      ['/user', '/fo', 'csv', '/nh'],
      options,
    ).toString();
  } catch (error) {
    // Restricted hosts may prohibit launching OS ACL tools. Keep the profile's
    // inherited ACL in that case, matching discovery. See the threat model.
    if (['EPERM', 'ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
  const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error('No se pudo proteger el acceso de la oficina');
  execFileSync(
    path.join(systemDir, 'icacls.exe'),
    [file, '/inheritance:r', '/grant:r', `*${sid}:(F)`],
    options,
  );
}

/** Atomic reads never return a partially written capability. Invalid files fail closed. */
export function readOfficeCredential(): OfficeCredential {
  try {
    const file = discoveryEntryPath(OFFICE_CREDENTIAL_FILE);
    if (!fs.statSync(file).isFile()) throw new Error();
    const credential = JSON.parse(fs.readFileSync(file, 'utf8')) as OfficeCredential;
    if (!/^[a-f0-9-]{36}$/.test(credential.token)) throw new Error();
    if (
      credential.port !== undefined &&
      (!Number.isInteger(credential.port) ||
        credential.port < MIN_PORT ||
        credential.port > MAX_PORT)
    )
      throw new Error();
    return credential;
  } catch {
    throw new Error('No se pudo leer el acceso guardado de la oficina');
  }
}

export function loadOfficeCredential(): OfficeCredential {
  return withDiscoveryLock(() => {
    const file = discoveryEntryPath(OFFICE_CREDENTIAL_FILE);
    if (fs.existsSync(file)) {
      const credential = readOfficeCredential();
      protectCredential(file);
      return credential;
    }
    const credential = { token: randomUUID() };
    writeDiscoveryRecord(OFFICE_CREDENTIAL_FILE, credential, protectCredential);
    return credential;
  });
}

export function rememberOfficePort(port: number): void {
  withDiscoveryLock(() => {
    const credential = readOfficeCredential();
    writeDiscoveryRecord(OFFICE_CREDENTIAL_FILE, { ...credential, port }, protectCredential);
  });
}

export function rotateOfficeToken(): string {
  return withDiscoveryLock(() => {
    const credential = readOfficeCredential();
    const token = randomUUID();
    new AuditLog().append({
      projectId: null,
      actorType: 'human',
      actorId: null,
      action: 'server.token.rotate',
      resourceType: 'server',
      resourceId: 'standalone',
      policyDecision: null,
      riskLevel: 'medium',
      outcome: { status: 'authorized' },
      taskKey: null,
      executionId: null,
    });
    writeDiscoveryRecord(OFFICE_CREDENTIAL_FILE, { ...credential, token }, protectCredential);
    return token;
  });
}
