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
  persistent?: boolean;
}

export class OfficeCredentialProtectionError extends Error {
  constructor() {
    super('No se pudo proteger y verificar el acceso de la oficina');
  }
}

/** Remove inherited grants before writing a secret into the exclusive temporary. */
export function protectCredential(file: string): void {
  try {
    applyCredentialProtection(file);
  } catch {
    throw new OfficeCredentialProtectionError();
  }
}

function applyCredentialProtection(file: string): void {
  if (process.platform !== 'win32') {
    fs.chmodSync(file, PRIVATE_FILE_MODE);
    return;
  }
  const options = { windowsHide: true, timeout: PRIVATE_COMMAND_TIMEOUT_MS };
  const systemDir = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const identity = execFileSync(
    path.join(systemDir, 'whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
    options,
  ).toString();
  const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error('No se pudo proteger el acceso de la oficina');
  execFileSync(
    path.join(systemDir, 'icacls.exe'),
    [file, '/inheritance:r', '/grant:r', `*${sid}:(F)`],
    options,
  );
  // Verify the effective DACL independently. icacls can retain explicit grants.
  const script = `$ErrorActionPreference = 'Stop'; $acl = Get-Acl -LiteralPath '${file.replace(/'/g, "''")}'; $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); if (!$acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IsInherited -or $rules[0].IdentityReference.Value -ne '${sid}' -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl') { exit 1 }; 'verified'`;
  const result = execFileSync(
    path.join(systemDir, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    options,
  )
    .toString()
    .trim();
  if (result !== 'verified') throw new Error('No se pudo verificar el acceso de la oficina');
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
  try {
    return withDiscoveryLock(() => {
      const file = discoveryEntryPath(OFFICE_CREDENTIAL_FILE);
      if (fs.existsSync(file)) {
        protectCredential(file);
        return { ...readOfficeCredential(), persistent: true };
      }
      const credential = { token: randomUUID() };
      writeDiscoveryRecord(OFFICE_CREDENTIAL_FILE, credential, protectCredential);
      return { ...credential, persistent: true };
    });
  } catch (error) {
    if (!(error instanceof OfficeCredentialProtectionError)) throw error;
    // No secret has been written to a temporary until protection succeeds.
    return { token: randomUUID(), persistent: false };
  }
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
