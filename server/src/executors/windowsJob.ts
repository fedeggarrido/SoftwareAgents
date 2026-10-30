import { EXECUTOR_TERMINATION_RETRY_MS, WORKSTORE_PROCESS_WAIT_MS } from '../constants.js';

/** Trusted, bundled source. No executable paths, prompts or model input enter this script. */
export const WINDOWS_JOB_API = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ExecutionJob {
  public static System.Threading.Tasks.Task<string> Command() { return System.Threading.Tasks.Task.Run(() => Console.ReadLine()); }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, IntPtr data, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int info, IntPtr data, uint size, IntPtr returned);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  public static string Name(int pid, long ticks) { return "Local\\SoftwareAgents-"+pid+"-"+ticks; }
  public static IntPtr Create(int pid, long ticks, IntPtr process) {
    IntPtr job=CreateJobObject(IntPtr.Zero,Name(pid,ticks));
    int error=Marshal.GetLastWin32Error();
    if(job==IntPtr.Zero) throw new Win32Exception(error);
    if(error==183) { CloseHandle(job); throw new Exception("Execution Job already exists"); }
    try {
      // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, native pointer alignment.
      int size=IntPtr.Size==8 ? 144 : 112;
      IntPtr data=Marshal.AllocHGlobal(size);
      try {
        for(int i=0;i<size;i++) Marshal.WriteByte(data,i,0);
        Marshal.WriteInt32(data,16,0x2000); // KILL_ON_JOB_CLOSE; no BREAKAWAY flags
        if(!SetInformationJobObject(job,9,data,(uint)size)) throw new Win32Exception();
      } finally { Marshal.FreeHGlobal(data); }
      if(!AssignProcessToJobObject(job,process)) throw new Win32Exception();
      return job;
    } catch { CloseHandle(job); throw; }
  }
  public static IntPtr Open(int pid, long ticks) {
    IntPtr job=OpenJobObject(0x0c,false,Name(pid,ticks)); // QUERY | TERMINATE
    int error=Marshal.GetLastWin32Error();
    if(job==IntPtr.Zero && error!=2) throw new Win32Exception(error);
    return job;
  }
  public static int Active(IntPtr job) {
    IntPtr data=Marshal.AllocHGlobal(48);
    try {
      if(!QueryInformationJobObject(job,1,data,48,IntPtr.Zero)) throw new Win32Exception();
      return Marshal.ReadInt32(data,40);
    } finally { Marshal.FreeHGlobal(data); }
  }
  public static void Kill(IntPtr job) {
    if(!TerminateJobObject(job,1)) throw new Win32Exception();
    var elapsed=System.Diagnostics.Stopwatch.StartNew();
    while(Active(job)!=0) {
      if(elapsed.ElapsedMilliseconds>=${WORKSTORE_PROCESS_WAIT_MS}) throw new Exception("Execution Job timeout");
      System.Threading.Thread.Sleep(${EXECUTOR_TERMINATION_RETRY_MS});
    }
  }
}`;

export const WINDOWS_JOB_LAUNCH = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${WINDOWS_JOB_API}
'@
$root=Get-Process -Id ([int]$env:SA_JOB_ROOT)
$job=[ExecutionJob]::Create($root.Id,$root.StartTime.ToUniversalTime().Ticks,$root.Handle)
try {
  [Console]::Out.WriteLine('JOB_READY'); [Console]::Out.Flush()
  $line=[ExecutionJob]::Command()
  $draining=$false
  while (-not $root.HasExited) {
    if ($line.IsCompleted) {
      if ($line.Result -eq 'cancel' -or $null -eq $line.Result) { [ExecutionJob]::Kill($job); break }
      if ($line.Result -eq 'drain') { $draining=$true }
      $line=[ExecutionJob]::Command()
    }
    if ($draining -and [ExecutionJob]::Active($job) -eq 1) {
      [Console]::Out.WriteLine('JOB_DRAINED'); [Console]::Out.Flush()
      $draining=$false
    }
    Start-Sleep -Milliseconds ${EXECUTOR_TERMINATION_RETRY_MS}
  }
} finally { [ExecutionJob]::CloseHandle($job) | Out-Null; $root.Dispose() }
`;
