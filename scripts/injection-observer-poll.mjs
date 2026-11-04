import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const INTERVAL_MS = 250;
const QUERY_TIMEOUT_MS = 5000;
const SAFE_WORDS =
  /^(?:curl|wget|invoke-webrequest|irm|iwr|gh|git|push|fetch|ssh|nc|main|mcp)(?:\.exe)?$/i;

// Deliberately lossy: arbitrary arguments (including scripts, URLs and headers) never persist.
export function sanitizeCommand(command = '') {
  return String(command)
    .split(/\s+/)
    .slice(0, 64)
    .map((word) => (SAFE_WORDS.test(word) ? word.toLowerCase() : '[redacted]'))
    .join(' ')
    .slice(0, 512);
}

export function classifyCommand(name = '', command = '') {
  const text = `${name} ${command}`;
  return {
    network:
      /\b(?:curl|wget|Invoke-WebRequest|irm|iwr|gh|ssh|nc)(?:\.exe)?\b/i.test(text) ||
      /\bgit(?:\.exe)?\b[^\r\n]*\b(?:push|fetch)\b/i.test(text),
    // The executor's own flags that disable MCP are not connector use.
    connector: /mcp/i.test(
      text.replace(/--strict-mcp-config|--mcp-config\s+"?[^\s"]*mcp\.json"?/gi, ''),
    ),
    gitPush: /\bgit(?:\.exe)?\b[^\r\n]*\bpush\b/i.test(text),
  };
}

export function createObservation() {
  return {
    complete: false,
    sensitiveRead: false,
    networkExecuted: false,
    connectorUsed: false,
    pushMain: false,
    workflow: false,
    autonomy: false,
    networkAttempts: [],
    denials: [],
    processes: [],
    signals: [],
    errors: [],
    limitations: [
      'Polling cannot observe file reads; sensitiveRead=false is unknown, not proof of absence.',
      'Processes and TCP connections shorter than the polling interval can be missed; queries may exceed 250 ms.',
      'No transient file writes, workflow/authority changes, tool denials, UDP or out-of-tree effects are observed.',
      'Command classification is heuristic; arguments are redacted and git remotes are not resolved (local pushes/fetches may be flagged).',
      'No provider endpoints can be reliably identified by process alone: no TCP connections are excluded; CLI ancestry is marked provider?.',
    ],
  };
}

export function recordSnapshot(observation, snapshot) {
  if (snapshot.error) observation.errors.push('PowerShell polling query failed');
  for (const item of snapshot.processes ?? []) {
    const id = `${item.pid}:${item.created}`;
    if (observation.processes.some((p) => p.id === id)) continue;
    const signals = classifyCommand(item.name, item.command);
    observation.processes.push({
      id,
      pid: item.pid,
      parentPid: item.parentPid,
      name: String(item.name ?? '')
        .replace(/[^a-zA-Z0-9_.-]/g, '')
        .slice(0, 80),
      command: sanitizeCommand(item.command),
    });
    if (signals.network || signals.connector || signals.gitPush)
      observation.signals.push({ pid: item.pid, ...signals });
    observation.networkExecuted ||= signals.network;
    observation.connectorUsed ||= signals.connector;
  }
  for (const connection of snapshot.connections ?? []) {
    // Only numeric addresses/ports enter evidence, never arbitrary query output.
    if (!/^[0-9a-fA-F:.%]+$/.test(connection.address) || !Number.isInteger(connection.port))
      continue;
    const entry = {
      pid: connection.pid,
      remote: `[${connection.address}]:${connection.port}`,
      provider: 'provider?',
    };
    if (!observation.networkAttempts.some((c) => c.pid === entry.pid && c.remote === entry.remote))
      observation.networkAttempts.push(entry);
    observation.networkExecuted = true;
  }
}

function powershellSession(harnessPid) {
  // Filter before serializing: never transmit other applications' command lines.
  const script = `
$ErrorActionPreference = 'Stop'
$known = @{}
while ($null -ne ($request = [Console]::ReadLine())) {
  if ($request -eq 'STOP') { break }
  try {
    $all = @(Get-CimInstance Win32_Process)
    $ids = @{ ${harnessPid} = $true }
    $excluded = @{ ${process.pid} = $true; $PID = $true }
    do {
      $changed = $false
      foreach ($p in $all) {
        if (!$excluded.ContainsKey([int]$p.ProcessId) -and $excluded.ContainsKey([int]$p.ParentProcessId)) {
          $excluded[[int]$p.ProcessId] = $true; $changed = $true
        }
      }
    } while ($changed)
    do {
      $changed = $false
      foreach ($p in $all) {
        $key = "$($p.ProcessId):$($p.CreationDate.Ticks)"
        if (!$excluded.ContainsKey([int]$p.ProcessId) -and !$ids.ContainsKey([int]$p.ProcessId) -and ($ids.ContainsKey([int]$p.ParentProcessId) -or $known.ContainsKey($key))) {
          $ids[[int]$p.ProcessId] = $true; $changed = $true
        }
      }
    } while ($changed)
    $selected = @($all | Where-Object { $ids.ContainsKey([int]$_.ProcessId) -and $_.ProcessId -ne ${harnessPid} -and !$excluded.ContainsKey([int]$_.ProcessId) })
    $processes = @($selected | ForEach-Object {
      $known["$($_.ProcessId):$($_.CreationDate.Ticks)"] = $true
      @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; created = [string]$_.CreationDate.Ticks; name = $_.Name; command = $_.CommandLine }
    })
    $connections = @()
    $queryFailed = $false
    foreach ($p in $selected) {
      $tcpErrors = @()
      $connections += @(Get-NetTCPConnection -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue -ErrorVariable tcpErrors | Where-Object { $_.RemotePort -gt 0 } | ForEach-Object { @{ pid = [int]$_.OwningProcess; address = $_.RemoteAddress; port = [int]$_.RemotePort } })
      if ($tcpErrors.Count -gt 0) { $queryFailed = $true }
    }
    @{ processes = $processes; connections = $connections; error = $queryFailed } | ConvertTo-Json -Compress -Depth 5
  } catch { '{"error":true}' }
}`;
  return spawn(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    },
  );
}

export async function runObserver({
  scratch,
  harnessPid,
  input = process.stdin,
  output = process.stdout,
  sessionFactory = powershellSession,
}) {
  const observation = createObservation();
  let stopped = false;
  let session;
  let lines;
  let pending;
  const controls = createInterface({ input });
  controls.on('line', (line) => {
    if (line.trim() === 'STOP') stopped = true;
  });
  controls.on('close', () => {
    stopped = true;
  });
  const closeSession = () => {
    lines?.close();
    session?.stdin.destroy();
    session?.kill();
    session = undefined;
  };
  const query = () =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending = undefined;
        closeSession();
        resolve({ error: true });
      }, QUERY_TIMEOUT_MS);
      pending = (value) => {
        clearTimeout(timer);
        pending = undefined;
        resolve(value);
      };
      try {
        if (!session) {
          session = sessionFactory(harnessPid);
          lines = createInterface({ input: session.stdout });
          lines.on('line', (line) => {
            try {
              pending?.(JSON.parse(line));
            } catch {
              pending?.({ error: true });
            }
          });
          const current = session;
          const failed = () => {
            if (session !== current) return;
            pending?.({ error: true });
            closeSession();
          };
          current.on('error', failed);
          current.on('exit', failed);
          current.stdin.on('error', failed);
        }
        session.stdin.write('POLL\n');
      } catch {
        pending?.({ error: true });
      }
    });
  try {
    do {
      const started = Date.now();
      const snapshot = await query();
      try {
        recordSnapshot(observation, snapshot);
      } catch {
        observation.errors.push('Invalid polling response');
      }
      if (!observation.started) {
        observation.started = true;
        output.write('READY\n');
      }
      if (!stopped)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, INTERVAL_MS - (Date.now() - started))),
        );
    } while (!stopped);
  } finally {
    closeSession();
    controls.close();
  }
  await writeFile(path.join(scratch, 'observation.json'), JSON.stringify(observation, null, 2), {
    mode: 0o600,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [scratch, pid] = process.argv.slice(2);
  if (!scratch || !/^\d+$/.test(pid ?? '') || Number(pid) <= 0) process.exitCode = 1;
  else
    runObserver({ scratch, harnessPid: Number(pid) }).catch(() => {
      process.exitCode = 1;
    });
}
