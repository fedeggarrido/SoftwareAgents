import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDocument } from 'yaml';

import { AuditLog } from '../auditLog.js';
import { CliUsageError } from '../cliErrors.js';
import {
  TASK_CLI_COPY_BUFFER_BYTES,
  TASK_CLI_DEFAULT_KEEP,
  TASK_CLI_INPUT_BYTES,
  TASK_CLI_MAX_KEEP,
} from '../constants.js';
import { lastDeveloperFailure } from '../developer.js';
import { confirmHumanIngress, featureIngressActor } from '../featureIngress.js';
import { parseFeatureSpec } from '../featureSpec.js';
import { loadProjectConfig } from '../projectConfig.js';
import { lastReviewFailure } from '../reviewAttempts.js';
import { analyzeTaskDag, parseTaskDag, taskDagDeclaration } from '../taskDag.js';
import { aggregateUsage } from '../usageLedger.js';
import { openWorkStore } from '../workstore/SqliteWorkStore.js';
import { isTaskStatus, type TaskStatus } from '../workstore/taskStateMachine.js';
import type { WorkStore } from '../workstore/WorkStore.js';
import { checkZones } from '../zonesCheck.js';
import { copyTaskFile, readTaskInput, taskDirectory, taskPath } from './taskFiles.js';

const BACKUP_FILES = ['work.sqlite3', 'audit.jsonl', 'manifest.json'] as const;
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f-]{36}$/;
const USAGE =
  'Usage: pixel-agents task import <dag.yaml> [--origin local|external] | list [--status S] [--json] | show <KEY> | backup [--keep N] | retry <KEY> --reason <text>';

/** Keep untrusted fields on one terminal line without executing control sequences. */
function textField(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, (control) => {
    if (control === '\n') return '\\n';
    if (control === '\r') return '\\r';
    if (control === '\t') return '\\t';
    return `\\u${control.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

function parseArgs(argv: string[]) {
  const [command, ...args] = argv;
  let status: TaskStatus | undefined;
  let json = false;
  let keep = TASK_CLI_DEFAULT_KEEP;
  if (command === 'show' && args.length === 1 && !args[0].startsWith('-'))
    return { command, file: args[0], status, json: true, keep };
  if (
    command === 'retry' &&
    args.length === 3 &&
    !args[0].startsWith('-') &&
    args[1] === '--reason' &&
    args[2].trim()
  )
    return { command, file: args[0], reason: args[2], status, json, keep };
  if (command === 'import') {
    if (
      !args[0] ||
      args[0].startsWith('-') ||
      !(
        args.length === 1 ||
        (args.length === 3 && args[1] === '--origin' && ['local', 'external'].includes(args[2]))
      )
    )
      throw new CliUsageError(USAGE);
    return { command, file: args[0], origin: args[2] ?? 'local', status, json, keep };
  }
  if (command === 'list') {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json' && !json) json = true;
      else if (args[i] === '--status' && status === undefined && isTaskStatus(args[i + 1] ?? ''))
        status = args[++i] as TaskStatus;
      else throw new CliUsageError(`${USAGE}. Invalid or duplicate list option/status.`);
    }
  } else if (command === 'backup') {
    if (args.length) {
      if (args.length !== 2 || args[0] !== '--keep' || !/^[1-9]\d*$/.test(args[1]))
        throw new CliUsageError(
          `${USAGE}. --keep must be an integer from 1 to ${TASK_CLI_MAX_KEEP}.`,
        );
      keep = Number(args[1]);
      if (keep > TASK_CLI_MAX_KEEP)
        throw new CliUsageError(`--keep must be from 1 to ${TASK_CLI_MAX_KEEP}`);
    }
  } else throw new CliUsageError(USAGE);
  return { command, file: undefined, status, json, keep };
}

function audit(
  projectId: string,
  action: string,
  status: string,
  input?: unknown,
  taskKey?: string,
) {
  // Direct append fails visibly; intent precedes mutation, completion follows commit.
  new AuditLog().append({
    projectId,
    actorType: 'human',
    actorId: 'operator',
    action,
    resourceType: taskKey ? 'task' : 'project',
    resourceId: taskKey ?? projectId,
    policyDecision: null,
    riskLevel: 'medium',
    taskKey: taskKey ?? null,
    executionId: null,
    outcome: { status },
    input,
  });
}

function list(store: WorkStore, status?: TaskStatus) {
  const tasks = store.listTasks();
  const usage = store.listUsage();
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const decisions = store.listDecisions().filter((decision) => decision.status === 'open');
  return tasks
    .filter((task) => !status || task.status === status)
    .map((task) => {
      const pendingDependencies = store
        .listTaskDependencies(task.key)
        .map((edge) => edge.depends_on_key)
        .filter((key) => byKey.get(key)?.status !== 'DONE');
      let resetsAt: string | null = null;
      let reason = task.blocked_reason;
      if (task.status === 'WAITING_QUOTA' && reason) {
        try {
          const quota = JSON.parse(reason);
          if (typeof quota.resetsAt === 'string') resetsAt = quota.resetsAt;
          if (typeof quota.reason === 'string') reason = quota.reason;
        } catch {
          /* Older reasons may be plain text. */
        }
      }
      const humanDecisions = decisions.filter((decision) => decision.blocks.includes(task.key));
      const event =
        task.status === 'WAITING_HUMAN' ? store.listDomainEvents(task.key).at(-1) : undefined;
      return {
        ...task,
        usage: aggregateUsage(
          usage.filter((entry) => entry.taskKey === task.key),
          [task],
        ),
        last_review_failure: lastReviewFailure(store, task),
        last_developer_failure: lastDeveloperFailure(store, task),
        pendingDependencies,
        resetsAt,
        blockingReasons: [
          ...(pendingDependencies.length
            ? [`Dependencies pending: ${pendingDependencies.join(', ')}`]
            : []),
          ...(reason ? [reason] : []),
          ...(task.status === 'WAITING_QUOTA'
            ? [`WAITING_QUOTA (resetsAt: ${resetsAt ?? 'unknown'})`]
            : []),
          ...(task.status === 'WAITING_HUMAN'
            ? [
                `WAITING_HUMAN: ${humanDecisions.map((decision) => `${decision.id}: ${decision.context}`).join('; ') || event?.reason || 'human answer required'}`,
              ]
            : []),
        ],
      };
    });
}

/** Remove only our three regular files, never traverse an unknown tree or a link. */
function removeBackup(root: string, name: string): void {
  const dir = taskPath(root, name);
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`Invalid backup directory: ${dir}`);
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (
      !BACKUP_FILES.includes(file as (typeof BACKUP_FILES)[number]) ||
      !fs.lstatSync(taskPath(dir, file)).isFile()
    )
      throw new Error(`Unexpected backup content: ${path.join(dir, file)}`);
  }
  for (const file of files) fs.unlinkSync(taskPath(dir, file));
  fs.rmdirSync(dir);
}

export async function backup(store: WorkStore, keep: number): Promise<string> {
  const home = fs.realpathSync.native(os.homedir());
  // AuditLog.file validates the Project id before it can become a path component.
  const auditFile = new AuditLog().file(store.projectId);
  const root = taskDirectory(home, `.pixel-agents/backups/${store.projectId}`);
  const backupLock = taskPath(root, '.backup.lock');
  const backupDescriptor = fs.openSync(backupLock, 'wx', 0o600);
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const stagingName = `.pending-${randomUUID()}`;
  const staging = taskPath(root, stagingName);
  try {
    taskDirectory(root, stagingName);
    const database = taskPath(staging, 'work.sqlite3');
    await store.backup(database);
    fs.chmodSync(database, 0o600);
    // Stop cooperating JSONL writers while copying; a stale/busy lock fails closed.
    // AuditLog builds its path from os.homedir(), which Windows may report in 8.3 short
    // form (C:\Users\RUNNER~1) while `home` is canonical; relate it to its own base.
    const relativeAudit = path.relative(os.homedir(), auditFile);
    taskDirectory(home, path.dirname(relativeAudit));
    taskPath(home, relativeAudit);
    const lock = taskPath(home, `${relativeAudit}.lock`);
    const fd = fs.openSync(lock, 'wx', 0o600);
    try {
      const output = taskPath(staging, 'audit.jsonl');
      if (fs.existsSync(auditFile)) copyTaskFile(taskPath(home, relativeAudit), output);
      else fs.writeFileSync(output, '', { flag: 'wx', mode: 0o600 });
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
    const hashes = Object.fromEntries(
      ['work.sqlite3', 'audit.jsonl'].map((file) => [file, hashFile(taskPath(staging, file))]),
    );
    const manifest = taskPath(staging, 'manifest.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify(
        {
          format: 1,
          projectId: store.projectId,
          createdAt: new Date().toISOString(),
          databaseScope: 'git-common-dir',
          hashes,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    for (const file of BACKUP_FILES) {
      const fd = fs.openSync(taskPath(staging, file), 'r+');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    const destination = taskPath(root, name);
    fs.renameSync(staging, destination);
    const names = fs
      .readdirSync(root)
      .filter((entry) => BACKUP_NAME.test(entry))
      .sort()
      .reverse();
    for (const old of names.slice(keep)) removeBackup(root, old);
    return destination;
  } catch (error) {
    if (fs.existsSync(staging)) removeBackup(root, stagingName);
    throw error;
  } finally {
    fs.closeSync(backupDescriptor);
    fs.unlinkSync(backupLock);
  }
}

function hashFile(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(TASK_CLI_COPY_BUFFER_BYTES);
    let count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

export async function runTaskCommand(
  argv: string[],
  cwd = process.cwd(),
  log = console.log,
): Promise<void> {
  if (argv[0] === 'retry') argv = await confirmHumanIngress(argv);
  const args = parseArgs(argv);
  if (args.command === 'retry' && featureIngressActor() !== 'human')
    throw new CliUsageError('task retry requires human ingress (SA-003)');
  let store: WorkStore | undefined;
  try {
    const config = loadProjectConfig(cwd, true);
    if (!config)
      throw new CliUsageError('task requires a bound Git Project (.softwareagents/project.yaml)');
    if (args.command === 'import') {
      // Check the declared path before its canonical form loses evidence of links.
      taskPath(cwd, config.project.brain.path);
      const source = readTaskInput(cwd, args.file!);
      const document = parseDocument(source, { uniqueKeys: true });
      if (document.errors.length)
        throw new Error(document.errors.map((error) => error.message).join('; '));
      const dag = parseTaskDag(document.toJS({ maxAliasCount: 100 }));
      // A local file can contain copied issues. The operator declares its source;
      // neither its filesystem location nor a human import makes it trusted.
      // Persist taint in the description (and immutable declaration) so every
      // existing task consumer reaches the compiler guard without a DB migration.
      if (args.origin === 'external')
        for (const task of dag.tasks)
          task.description = JSON.stringify({
            provenance: 'untrusted-external',
            origin: 'task-import',
            text: task.description,
          });
      // Resolve canonical pipeline artifacts without opening/activating SQLite for invalid DAGs.
      // Relate Brain paths to the canonical repo root they are built from: `cwd` may be
      // the same directory in Windows 8.3 short form, which would yield a '..' escape.
      const pipelineSpec = path.relative(
        config.repoRoot,
        path.join(config.paths.brain, 'features', `${dag.feature}.yaml`),
      );
      const specRelative = fs.existsSync(taskPath(cwd, pipelineSpec))
        ? pipelineSpec
        : path.relative(
            config.repoRoot,
            path.join(config.paths.brain, 'features/requests', `${dag.feature}.yaml`),
          );
      const spec = parseFeatureSpec(readTaskInput(cwd, specRelative), specRelative);
      const analysis = analyzeTaskDag(dag, spec);
      if (!analysis.valid) throw new Error(`Invalid TaskDAG: ${JSON.stringify(analysis.issues)}`);
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
      store = await openWorkStore({ repositoryPath: cwd, projectId: config.project.id });
      const design = store.getDesign(dag.feature);
      if (design) {
        const registered = parseDocument(
          execFileSync('git', ['show', `${design.git_sha}:${design.dag_path}`], {
            cwd,
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: TASK_CLI_INPUT_BYTES,
          }),
          { uniqueKeys: true },
        );
        if (registered.errors.length) throw new Error('Invalid registered TaskDAG');
        if (
          taskDagDeclaration(dag) !==
          taskDagDeclaration(parseTaskDag(registered.toJS({ maxAliasCount: 100 })))
        )
          throw new Error('TaskDAG differs from the registered design; run feature design again');
      }
      taskDirectory(os.homedir(), '.pixel-agents/audit');
      taskPath(os.homedir(), `.pixel-agents/audit/${config.project.id}.jsonl`);
      taskPath(os.homedir(), `.pixel-agents/audit/${config.project.id}.jsonl.lock`);
      audit(config.project.id, 'task_import', 'intent', dag);
      const created = await store.importTaskDag(dag, {
        key: dag.feature,
        title: spec.title,
        doc_path: specRelative,
        git_sha: sha,
        status: spec.status,
      });
      audit(config.project.id, 'task_import', 'committed', { feature: dag.feature, created });
      log(
        `Imported ${textField(dag.feature)}: ${created} created, ${dag.tasks.length - created} unchanged`,
      );
    } else {
      store = await openWorkStore({ repositoryPath: cwd, projectId: config.project.id });
      if (args.command === 'show') {
        const task = store.getTask(args.file!);
        if (!task) throw new CliUsageError('Unknown task');
        const report = await checkZones(config.repoRoot, store.listTasks());
        const branch = task.branch ?? `sa/${task.key}-developer`;
        log(
          JSON.stringify(
            {
              ...task,
              zoneWait: task.feature_key
                ? store.getFeatureRun(task.feature_key)?.state.zoneWait
                : null,
              zoneWarnings: {
                overlaps: report.overlaps.filter((item) => item.branches.includes(branch)),
                outsideZones:
                  report.branches.find((item) => item.branch === branch)?.outsideZones ?? [],
              },
            },
            null,
            2,
          ),
        );
      } else if (args.command === 'retry') {
        const task = store.getTask(args.file!);
        if (!task) throw new Error('Unknown task');
        const destination = await backup(store, args.keep);
        const input = { task: task.key, reason: args.reason!, backup: destination };
        const result = await store.retryTask(task.key, task.version, args.reason!, () =>
          audit(config.project.id, 'manual_retry', 'intent', input, task.key),
        );
        audit(config.project.id, 'manual_retry', 'committed', input, task.key);
        log(textField(`${result.key}: ${result.status}; backup: ${destination}`));
      } else if (args.command === 'backup') log(textField(await backup(store, args.keep)));
      else {
        const tasks = list(store, args.status);
        if (args.json) log(JSON.stringify(tasks, null, 2));
        else
          log(
            tasks
              .map(
                (task) =>
                  `${textField(task.key)}\t${textField(task.status)}\towner=${textField(task.lease_owner ?? '-')}\texpires=${textField(task.lease_expires_at ?? '-')}\t${textField(task.blockingReasons.join('; '))}${task.last_review_failure ? `\t${textField(task.last_review_failure.reason)}` : ''}${task.last_developer_failure ? `\t${textField(task.last_developer_failure.reason)}` : ''}`,
              )
              .join('\n') || 'No tasks',
          );
      }
    }
  } catch (error) {
    throw new CliUsageError(
      `task ${textField(args.command)}: ${textField((error as Error).message)}`,
    );
  } finally {
    store?.close();
  }
}
