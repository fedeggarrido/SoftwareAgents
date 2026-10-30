import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { matchesChangeZone } from './changeZones.js';
import { CliUsageError } from './cliErrors.js';
import {
  ZONES_CHECK_INTERVAL_MS,
  ZONES_GIT_BUFFER_BYTES,
  ZONES_GIT_TIMEOUT_MS,
} from './constants.js';
import { loadProjectConfig } from './projectConfig.js';
import { openReadOnlyWorkStore } from './workstore/readOnlyWorkStore.js';
import { taskZones } from './zoneAdmission.js';

export interface BranchZones {
  branch: string;
  files: string[];
  outsideZones: string[];
}
export interface ZonesReport {
  branches: BranchZones[];
  /** Branches that could not be diffed this scan (deleted, no merge base, limits). */
  skipped?: { branch: string; reason: string }[];
  overlaps: { file: string; branches: string[] }[];
}
export interface ZoneTask {
  key: string;
  branch?: string | null;
  feature_key?: string | null;
  declaration?: string | null;
}

/** Local git only; asynchronous children have bounded runtime and output. */
export async function checkZones(root: string, tasks: ZoneTask[] = []): Promise<ZonesReport> {
  const git = async (...args: string[]) =>
    (
      await promisify(execFile)(
        'git',
        ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args],
        {
          cwd: root,
          windowsHide: true,
          timeout: ZONES_GIT_TIMEOUT_MS,
          maxBuffer: ZONES_GIT_BUFFER_BYTES,
        },
      )
    ).stdout;
  const names = (
    await git(
      'for-each-ref',
      '--format=%(refname:short)',
      '--no-merged=refs/heads/main',
      'refs/heads/sa/',
    )
  )
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);
  const branches: BranchZones[] = [];
  const skipped: { branch: string; reason: string }[] = [];
  for (const branch of names) {
    // One branch deleted mid-scan, without a merge base or over the limits must not
    // hide the overlaps of every other branch.
    let files: string[];
    try {
      const base = (await git('merge-base', 'refs/heads/main', `refs/heads/${branch}`)).trim();
      files = (await git('diff', '--name-only', '-z', `${base}..refs/heads/${branch}`))
        .split('\0')
        .filter(Boolean);
    } catch (error) {
      skipped.push({ branch, reason: (error as Error).message.split('\n')[0].slice(0, 200) });
      continue;
    }
    const declarations = tasks.filter(
      (task) =>
        task.branch === branch ||
        branch === `sa/${task.key}-developer` ||
        branch === `sa/${task.feature_key}-integration`,
    );
    const zones = declarations.flatMap(taskZones);
    const outsideZones = zones.length
      ? files.filter(
          (file) =>
            !zones.some((zone) => {
              const directory =
                zone.endsWith('/') ||
                (!zone.includes('*') &&
                  fs.existsSync(path.join(root, zone)) &&
                  fs.statSync(path.join(root, zone)).isDirectory());
              return matchesChangeZone(file, zone, directory);
            }),
        )
      : [];
    branches.push({ branch, files, outsideZones });
  }
  const touched = new Map<string, string[]>();
  for (const branch of branches)
    for (const file of branch.files)
      touched.set(file, [...(touched.get(file) ?? []), branch.branch]);
  return {
    branches,
    ...(skipped.length ? { skipped } : {}),
    overlaps: [...touched]
      .filter(([, refs]) => refs.length > 1)
      .map(([file, refs]) => ({ file, branches: refs })),
  };
}

// A single in-flight scan per repository. The office refresh starts monitoring;
// unref timers never keep the server alive and scans cannot overlap themselves.
const monitors = new Map<
  string,
  { report?: ZonesReport; pending?: Promise<void>; tasks: ZoneTask[] }
>();
export async function monitoredZones(
  root: string,
  tasks: ZoneTask[],
): Promise<ZonesReport | undefined> {
  let monitor = monitors.get(root);
  if (!monitor) {
    monitor = { tasks };
    monitors.set(root, monitor);
    const scan = () => {
      if (!monitor!.pending)
        monitor!.pending = checkZones(root, monitor!.tasks)
          .then((report) => {
            monitor!.report = report;
          })
          // Branch failures are isolated in checkZones; if listing itself fails, keep the
          // last good report rather than silently dropping every warning.
          .catch(() => {})
          .finally(() => {
            monitor!.pending = undefined;
          });
      return monitor!.pending;
    };
    setInterval(() => void scan(), ZONES_CHECK_INTERVAL_MS).unref();
    await scan();
  }
  monitor.tasks = tasks;
  return monitor.report;
}

export async function runZonesCommand(
  argv: string[],
  cwd = process.cwd(),
  log = console.log,
): Promise<void> {
  if (argv[0] !== 'check' || argv.length > 2 || (argv[1] !== undefined && argv[1] !== '--json'))
    throw new CliUsageError('Usage: pixel-agents zones check [--json]');
  const config = loadProjectConfig(cwd);
  const root = config?.repoRoot ?? cwd;
  let tasks: ZoneTask[] = [];
  if (config) {
    const db = openReadOnlyWorkStore(root);
    try {
      tasks = db
        .prepare('SELECT key, branch, feature_key, declaration FROM tasks WHERE project_id = ?')
        .all(config.project.id) as unknown as ZoneTask[];
    } finally {
      db.close();
    }
  }
  const report = await checkZones(root, tasks);
  log(
    argv[1] === '--json'
      ? JSON.stringify(report, null, 2)
      : [
          ...report.overlaps.map((item) => `${item.file}: ${item.branches.join(', ')}`),
          ...report.branches.flatMap((branch) =>
            branch.outsideZones.map((file) => `${branch.branch}: outside declared zones: ${file}`),
          ),
        ].join('\n') || 'No zone overlaps',
  );
}
