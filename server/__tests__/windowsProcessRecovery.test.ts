import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { processStartIdentity } from '../src/workstore/processRecovery.js';
import { WINDOWS_PROCESS_HELPER } from '../src/workstore/windowsProcessRecovery.js';

it.skipIf(process.platform !== 'win32')(
  'ACCESS_DENIED waits for exit and preserves the original error on timeout or query failure',
  async () => {
    const fixture = `
public static class DeniedRegression {
  public static void Run() {
    NativeRecoveryProcessApi.CheckTerminationError(5, () => 0, () => { throw new System.Exception("must not query"); });
    foreach(bool broken in new bool[]{false,true}) {
      try {
        NativeRecoveryProcessApi.CheckTerminationError(5, () => 258, () => { if(broken) throw new System.Exception("query failed"); return false; });
        throw new System.Exception("expected denial");
      } catch(System.ComponentModel.Win32Exception e) { if(e.NativeErrorCode!=5) throw; }
    }
  }
}`;
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${WINDOWS_PROCESS_HELPER}\n${fixture}\n'@\n[DeniedRegression]::Run(); 'DENIED_OK'`,
      ],
      { windowsHide: true, timeout: 20000 },
    );
    expect(stdout.trim()).toBe('DENIED_OK');
  },
  25000,
);

it.skipIf(process.platform !== 'win32')(
  'native helper verifies, terminates and waits for a real fixture through one retained handle',
  async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const exited = once(child, 'exit');
    try {
      await once(child, 'spawn');
      const identity = await processStartIdentity(child.pid!);
      expect(identity).toMatch(/^\d+$/);
      const { stdout } = await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${WINDOWS_PROCESS_HELPER}\n'@\n` +
            `$p=[HeldRecoveryProcess]::Open(${child.pid}); try { ` +
            `if ($null -eq $p -or $p.StartTicks -ne [long]'${identity}') { throw 'identity mismatch' }; ` +
            `$p.Kill(); if (-not $p.HasExited) { throw 'still alive' }; 'NATIVE_OK' ` +
            `} finally { if ($null -ne $p) { $p.Dispose() } }`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 20000 },
      );
      expect(stdout.trim()).toBe('NATIVE_OK');
      await exited;
      expect(await processStartIdentity(child.pid!)).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  },
  25000,
);

it.skipIf(process.platform !== 'win32')(
  'native helper kills only the retained handle when the PID mapping changes after identity lookup',
  async () => {
    // Runs the production C# VerifyAndKill algorithm, with deterministic kernel API doubles.
    const fake = `
public class ReusedPidApi : IRecoveryProcessApi {
  public int PidHandle=11;
  public int Killed=0;
  public bool Mismatch=false;
  public long Created(System.IntPtr h) { PidHandle=22; return Mismatch ? 999 : 123; }
  public bool Exited(System.IntPtr h) { return false; }
  public void Terminate(System.IntPtr h) { Killed=h.ToInt32(); }
  public void Wait(System.IntPtr h) { if(h.ToInt32()!=11) throw new System.Exception("wrong wait handle"); }
}`;
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${WINDOWS_PROCESS_HELPER}\n${fake}\n'@\n` +
          `$api=New-Object ReusedPidApi; [HeldRecoveryProcess]::VerifyAndKill($api,[IntPtr]11,123); ` +
          `if ($api.PidHandle -ne 22 -or $api.Killed -ne 11) { throw 'recycled PID was killed' }; ` +
          `$api=New-Object ReusedPidApi; $api.Mismatch=$true; ` +
          `try { [HeldRecoveryProcess]::VerifyAndKill($api,[IntPtr]11,123); throw 'expected identity rejection' } ` +
          `catch { if ($api.Killed -ne 0 -or $_.ToString() -notmatch 'identity changed') { throw } }; 'HANDLE_OK'`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
    );
    expect(stdout.trim()).toBe('HANDLE_OK');
  },
  25_000,
);
