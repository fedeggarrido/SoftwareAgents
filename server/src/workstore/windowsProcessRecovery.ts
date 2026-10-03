import { WORKSTORE_PROCESS_WAIT_MS } from '../constants.js';

/** Bundled native helper: identity, termination and wait use the same retained handle. */
export const WINDOWS_PROCESS_HELPER = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public interface IRecoveryProcessApi {
  long Created(IntPtr handle);
  bool Exited(IntPtr handle);
  void Terminate(IntPtr handle);
  void Wait(IntPtr handle);
}
public class NativeRecoveryProcessApi : IRecoveryProcessApi {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  public long Created(IntPtr handle) {
    long c,e,k,u;
    if (!GetProcessTimes(handle, out c, out e, out k, out u)) throw new Win32Exception();
    return DateTime.FromFileTimeUtc(c).Ticks;
  }
  public bool Exited(IntPtr handle) {
    uint result = WaitForSingleObject(handle, 0);
    if (result == 0xffffffff) throw new Win32Exception();
    return result == 0;
  }
  public void Terminate(IntPtr handle) {
    if (TerminateProcess(handle, 1)) return;
    // Capture the error before any other API call overwrites it.
    int error = Marshal.GetLastWin32Error();
    // ERROR_ACCESS_DENIED is what Windows returns for a process that is already
    // exiting (e.g. a conhost closing after its console client died): wait for it.
    if (error == 5 && WaitForSingleObject(handle, ${WORKSTORE_PROCESS_WAIT_MS}) == 0) return;
    if (Exited(handle)) return;
    throw new Win32Exception(error);
  }
  public void Wait(IntPtr handle) {
    if (WaitForSingleObject(handle, ${WORKSTORE_PROCESS_WAIT_MS}) != 0) throw new Exception("Executor is still alive or wait failed");
  }
}
public class HeldRecoveryProcess : IDisposable {
  public readonly int Pid;
  public readonly long StartTicks;
  readonly IntPtr handle;
  readonly IRecoveryProcessApi api;
  HeldRecoveryProcess(int pid, IntPtr h, IRecoveryProcessApi a) {
    Pid=pid; handle=h; api=a; StartTicks=api.Created(handle);
  }
  public static HeldRecoveryProcess Open(int pid) {
    // PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
    IntPtr h=NativeRecoveryProcessApi.OpenProcess(0x00101001, false, pid);
    if (h == IntPtr.Zero) {
      int error=Marshal.GetLastWin32Error();
      if (error == 87) return null;
      throw new Win32Exception(error);
    }
    try { return new HeldRecoveryProcess(pid,h,new NativeRecoveryProcessApi()); }
    catch { NativeRecoveryProcessApi.CloseHandle(h); throw; }
  }
  // Injected API is used only by the deterministic native-helper regression test.
  public static void VerifyAndKill(IRecoveryProcessApi api, IntPtr handle, long expected) {
    if (api.Created(handle) != expected) throw new Exception("Process identity changed; tree closure unproven");
    if (!api.Exited(handle)) api.Terminate(handle);
    api.Wait(handle);
  }
  public void Kill() { VerifyAndKill(api,handle,StartTicks); }
  public bool HasExited { get { return api.Exited(handle); } }
  public void Dispose() { NativeRecoveryProcessApi.CloseHandle(handle); }
}`;

/** CIM queries only children of pinned processes, never scans unrelated host processes. */
export function windowsTerminationScript(pid: number, identity: string): string {
  return `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${WINDOWS_PROCESS_HELPER}
'@
$held=New-Object 'System.Collections.Generic.List[HeldRecoveryProcess]'
try {
  $root=[HeldRecoveryProcess]::Open(${pid})
  if ($null -eq $root) { throw 'Executor root disappeared; tree closure unproven' }
  $held.Add($root)
  if ($root.StartTicks -ne [long]'${identity}') { throw 'Executor PID reused; tree closure unproven' }
  if ($root.HasExited) { throw 'Executor root disappeared; tree closure unproven' }
  for ($i=0; $i -lt $held.Count; $i++) {
    $parent=$held[$i]
    $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($parent.Pid)")
    foreach ($child in $children) {
      $created=$child.CreationDate.ToUniversalTime().Ticks
      if ($created -lt $parent.StartTicks) { continue }
      if ($held.Pid -contains [int]$child.ProcessId) { continue }
      $p=[HeldRecoveryProcess]::Open([int]$child.ProcessId)
      if ($null -eq $p) { throw 'Descendant disappeared during discovery; tree closure unproven' }
      $held.Add($p)
      # CIM dates have microsecond precision; keep the handle after validation.
      if ([decimal]::Truncate($p.StartTicks / [decimal]10) -ne [decimal]::Truncate($created / [decimal]10)) {
        throw 'Descendant PID reused during discovery; tree closure unproven'
      }
    }
  }
  if ($root.HasExited) { throw 'Executor root disappeared during discovery; tree closure unproven' }
  # Leaves first: killing a parent first makes children such as conhost start exiting on their own.
  for ($i=$held.Count-1; $i -ge 0; $i--) { $held[$i].Kill() }
  'TREE_CLOSED'
} finally { foreach ($p in $held) { $p.Dispose() } }`;
}
