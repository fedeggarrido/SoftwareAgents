import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

import { validGithubName, validGithubOwner } from '../../core/src/githubHosting.js';
import type {
  GithubHostingOptions,
  GithubHostingResult,
  GithubVisibility,
} from '../../core/src/messages.js';
import { projectSlug } from '../../core/src/projectNaming.js';
import { AuditLog } from './auditLog.js';
import { companyWorkspaceRoot } from './companyControl.js';
import {
  GITHUB_CONFIRMATION_LIMIT,
  GITHUB_CONFIRMATION_TTL_MS,
  GITHUB_INITIAL_COMMIT_MESSAGE,
  PROJECT_MANIFEST_PATH,
} from './constants.js';
import { featureIngressActor } from './featureIngress.js';
import {
  failGithub,
  githubCommandError,
  type GithubCommandRunner,
  GithubHostingFailure,
  runGithubCommand,
} from './githubCommand.js';
import { requireProjectDirectory } from './newProjectPaths.js';
import { loadProjectConfig } from './projectConfig.js';

interface Destination {
  login: string;
  owner: string;
  name: string;
  visibility: GithubVisibility;
}
interface Confirmation {
  root: string;
  projectId: string;
  login: string;
  owners: string[];
  expires: number;
}

function audit(projectId: string, status: string): void {
  new AuditLog().append({
    projectId,
    action: 'github_hosting',
    resourceType: 'project',
    resourceId: projectId,
    actorType: 'human',
    actorId: 'operator',
    policyDecision: null,
    riskLevel: 'high',
    taskKey: null,
    executionId: null,
    outcome: { status },
  });
}

/** A process-local capability is consumed before awaiting any creation command. */
export function createGithubHostingService(run: GithubCommandRunner = runGithubCommand) {
  const confirmations = new Map<string, Confirmation>();
  const active = new Set<string>();
  // A successful creation followed by a failed push may only resume that push.
  const awaitingPush = new Map<string, Destination>();
  const command = async (tool: 'gh' | 'git', args: string[], root: string) => {
    const result = await run(tool, args, root);
    if (result.code !== 0) return failGithub(githubCommandError(result, tool));
    return result.stdout.trim();
  };
  const account = async (root: string) => {
    const auth = await run('gh', ['auth', 'status', '--hostname', 'github.com'], root);
    if (auth.code !== 0) {
      const reason = githubCommandError(auth);
      return failGithub(reason === 'unavailable' ? 'unauthenticated' : reason);
    }
    const login = await command(
      'gh',
      ['api', '--hostname', 'github.com', 'user', '--jq', '.login'],
      root,
    );
    const orgs = await command(
      'gh',
      ['api', '--hostname', 'github.com', 'user/orgs', '--paginate', '--jq', '.[].login'],
      root,
    );
    const owners = [...new Set([login, ...orgs.split(/\r?\n/).filter(Boolean)])];
    if (!owners.every(validGithubOwner)) return failGithub('unavailable');
    return { login, owners };
  };
  const origin = async (root: string) => {
    const remotes = await command('git', ['remote'], root);
    return remotes.split(/\r?\n/).includes('origin');
  };
  const assertPushDestination = async (root: string, destination: Destination) => {
    const urls = await command('git', ['remote', 'get-url', '--push', '--all', 'origin'], root);
    const repo = `${destination.owner}/${destination.name}`;
    if (
      ![
        `https://github.com/${repo}`,
        `https://github.com/${repo}.git`,
        `git@github.com:${repo}`,
        `git@github.com:${repo}.git`,
      ].includes(urls)
    )
      return failGithub('origin_exists');
  };
  const ensureCommit = async (root: string) => {
    const head = await run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], root);
    if (head.code === 0) return;
    // Require a normal unborn branch before creating a commit.
    await command('git', ['symbolic-ref', '--quiet', 'HEAD'], root);
    for (const key of ['user.name', 'user.email']) {
      const identity = await run('git', ['config', '--get', key], root);
      if (identity.code !== 0 || !identity.stdout.trim()) return failGithub('identity_missing');
    }
    // Commit only the prepared manifest, preserving unrelated staged/local files.
    await command('git', ['add', '--', PROJECT_MANIFEST_PATH], root);
    await command(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--only',
        '-m',
        GITHUB_INITIAL_COMMIT_MESSAGE,
        '--',
        PROJECT_MANIFEST_PATH,
      ],
      root,
    );
    await command('git', ['rev-parse', '--verify', 'HEAD^{commit}'], root);
  };

  return async function handleGithubHostingMessage(
    msg: Record<string, unknown>,
    send: (message: Record<string, unknown>) => void,
    privileged: boolean,
  ): Promise<void> {
    if (typeof msg.requestId !== 'string' || typeof msg.projectId !== 'string') return;
    const creating = msg.type === 'confirmGithubHosting';
    if (!creating && msg.type !== 'requestGithubHosting') return;
    let reply: GithubHostingOptions | GithubHostingResult = creating
      ? {
          type: 'githubHostingResult',
          requestId: msg.requestId,
          projectId: msg.projectId,
          status: 'rejected',
          errorCode: null,
        }
      : {
          type: 'githubHostingOptions',
          requestId: msg.requestId,
          projectId: msg.projectId,
          login: null,
          owners: [],
          owner: '',
          name: '',
          visibility: 'private',
          confirmationId: null,
          operation: 'create',
          errorCode: null,
        };
    let lockedRoot: string | undefined;
    try {
      if (!privileged || featureIngressActor() !== 'human') return failGithub('denied');
      const keys = creating ? ['confirmationId', 'owner', 'name', 'visibility'] : [];
      if (
        Object.keys(msg).some((key) => !['type', 'requestId', 'projectId', ...keys].includes(key))
      )
        return failGithub('invalid_request');
      const selected = companyWorkspaceRoot();
      if (!selected) return failGithub('unknown_project');
      const directory = requireProjectDirectory(selected);
      const config = loadProjectConfig(directory);
      if (config?.project.id !== msg.projectId) return failGithub('unknown_project');
      const root = config.repoRoot;
      if (active.has(root)) return failGithub('busy');
      if (creating) {
        const confirmation =
          typeof msg.confirmationId === 'string'
            ? confirmations.get(msg.confirmationId)
            : undefined;
        if (
          !confirmation ||
          confirmation.expires <= Date.now() ||
          confirmation.root !== root ||
          confirmation.projectId !== msg.projectId
        )
          return failGithub('confirmation_required');
        // Invalidate all outstanding confirmations for this Project before any await.
        for (const [key, value] of confirmations)
          if (value.root === root) confirmations.delete(key);
        if (
          typeof msg.owner !== 'string' ||
          !confirmation.owners.includes(msg.owner) ||
          typeof msg.name !== 'string' ||
          !validGithubName(msg.name) ||
          (msg.visibility !== 'private' && msg.visibility !== 'public')
        )
          return failGithub('invalid_request');
        active.add(root);
        lockedRoot = root;
        const current = await account(root);
        if (current.login !== confirmation.login || !current.owners.includes(msg.owner))
          return failGithub('account_changed');
        const destination: Destination = {
          login: current.login,
          owner: msg.owner,
          name: msg.name,
          visibility: msg.visibility,
        };
        const resume = awaitingPush.get(root);
        if (
          resume &&
          (resume.login !== destination.login ||
            resume.owner !== destination.owner ||
            resume.name !== destination.name ||
            resume.visibility !== destination.visibility)
        )
          return failGithub('invalid_request');
        const top = await command('git', ['rev-parse', '--show-toplevel'], root);
        if (fs.realpathSync.native(top) !== config.repoRoot) return failGithub('unknown_project');
        if (resume) await assertPushDestination(root, resume);
        else if (await origin(root)) return failGithub('origin_exists');
        await ensureCommit(root);
        if (!privileged || featureIngressActor() !== 'human') return failGithub('denied');
        if (
          companyWorkspaceRoot() !== selected ||
          loadProjectConfig(root)?.project.id !== msg.projectId
        )
          return failGithub('unknown_project');
        audit(msg.projectId, 'confirmed');
        if (!resume) {
          await command(
            'gh',
            [
              'repo',
              'create',
              `${destination.owner}/${destination.name}`,
              `--${destination.visibility}`,
              '--source',
              root,
              '--remote',
              'origin',
            ],
            root,
          );
          awaitingPush.set(root, destination);
        }
        await assertPushDestination(root, destination);
        const pushed = await run(
          'git',
          ['-c', 'core.hooksPath=/dev/null', 'push', '--set-upstream', 'origin', 'HEAD'],
          root,
        );
        if (pushed.code !== 0) {
          const reason = githubCommandError(pushed, 'git');
          return failGithub(reason === 'unavailable' ? 'push_failed' : reason);
        }
        awaitingPush.delete(root);
        reply = {
          type: 'githubHostingResult',
          requestId: msg.requestId,
          projectId: msg.projectId,
          status: 'published',
          errorCode: null,
        };
        // A post-action audit failure must never turn success into a retryable creation.
        try {
          audit(msg.projectId, 'published');
        } catch {
          /* The confirmed intent remains. */
        }
      } else {
        const current = await account(root);
        if (companyWorkspaceRoot() !== selected) return failGithub('unknown_project');
        const resume = awaitingPush.get(root);
        if (resume) {
          if (current.login !== resume.login) return failGithub('account_changed');
          await assertPushDestination(root, resume);
        } else if (await origin(root)) return failGithub('origin_exists');
        if (active.has(root)) return failGithub('busy');
        for (const [key, value] of confirmations)
          if (value.expires <= Date.now()) confirmations.delete(key);
        if (confirmations.size >= GITHUB_CONFIRMATION_LIMIT) return failGithub('busy');
        const confirmationId = randomUUID();
        confirmations.set(confirmationId, {
          root,
          projectId: msg.projectId,
          ...current,
          expires: Date.now() + GITHUB_CONFIRMATION_TTL_MS,
        });
        reply = {
          type: 'githubHostingOptions',
          requestId: msg.requestId,
          projectId: msg.projectId,
          ...current,
          owner: resume?.owner ?? current.login,
          name: resume?.name ?? projectSlug(config.project.name),
          visibility: resume?.visibility ?? 'private',
          confirmationId,
          operation: resume ? 'push' : 'create',
          errorCode: null,
        };
      }
    } catch (error) {
      reply.errorCode = error instanceof GithubHostingFailure ? error.code : 'unavailable';
    } finally {
      if (lockedRoot) active.delete(lockedRoot);
    }
    send({ ...reply });
  };
}

export const handleGithubHostingMessage = createGithubHostingService();
