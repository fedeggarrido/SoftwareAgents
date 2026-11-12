import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { githubHostingErrorText } from '../../core/src/githubHosting.js';
import * as company from '../src/companyControl.js';
import { GITHUB_CONFIRMATION_TTL_MS } from '../src/constants.js';
import type { GithubCommandResult, GithubCommandRunner } from '../src/githubCommand.js';
import { createGithubHostingService } from '../src/githubHosting.js';

vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => process.env.HOME!,
}));

const markers = ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'];
const ok = (stdout = ''): GithubCommandResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string, code: string | number = 1): GithubCommandResult => ({
  code,
  stdout: '',
  stderr,
});
let temporary: string;
let root: string;
let handle: ReturnType<typeof createGithubHostingService>;
let run: ReturnType<typeof vi.fn<GithubCommandRunner>>;
let override: GithubCommandRunner;
let remote: string;
let head: 'unborn' | 'committed';
let login: string;

async function request(
  type = 'requestGithubHosting',
  fields: Record<string, unknown> = {},
  privileged = true,
) {
  const replies: Record<string, unknown>[] = [];
  await handle(
    { type, requestId: 'request', projectId: 'tienda', ...fields },
    (reply) => replies.push(reply),
    privileged,
  );
  expect(replies).toHaveLength(1);
  return replies[0];
}
async function options() {
  const reply = await request();
  expect(reply.errorCode).toBeNull();
  return reply;
}
function confirm(confirmationId: unknown, fields: Record<string, unknown> = {}) {
  return request('confirmGithubHosting', {
    confirmationId,
    owner: login,
    name: 'tienda',
    visibility: 'private',
    ...fields,
  });
}

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sa146-'));
  root = path.join(temporary, 'project');
  fs.mkdirSync(path.join(root, '.softwareagents', 'brain'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.softwareagents', 'project.yaml'),
    JSON.stringify({
      apiVersion: 'softwareagents.io/v1alpha1',
      kind: 'Project',
      id: 'tienda',
      name: 'Tienda',
      repo: { remote: 'local', defaultBranch: 'main' },
      brain: { path: '.softwareagents/brain' },
    }),
  );
  const home = path.join(temporary, 'home');
  fs.mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  for (const marker of markers) vi.stubEnv(marker, undefined);
  vi.spyOn(company, 'companyWorkspaceRoot').mockImplementation(() => root);
  remote = '';
  head = 'committed';
  login = 'operador';
  override = async (tool, args) => {
    if (tool === 'gh') {
      if (args[0] === 'auth') return ok();
      if (args.includes('user')) return ok(login);
      if (args.includes('user/orgs')) return ok('mi-organizacion\notra-org\n');
      if (args[0] === 'repo') {
        remote = `https://github.com/${args[2]}.git`;
        return ok();
      }
    }
    if (args[0] === 'remote' && args.length === 1) return ok(remote ? 'origin' : '');
    if (args[0] === 'remote') return ok(remote);
    if (args.includes('--show-toplevel')) return ok(root);
    if (args.includes('--verify'))
      return head === 'committed' ? ok('abc123') : failed('unborn', 128);
    if (args[0] === 'config') return ok('Identidad de prueba');
    if (args.includes('commit')) head = 'committed';
    return ok();
  };
  run = vi.fn((tool, args, cwd) => override(tool, args, cwd));
  handle = createGithubHostingService(run);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('SA-146 account discovery and human ingress', () => {
  it('detects login and paginated organizations with a private repository default', async () => {
    expect(await options()).toMatchObject({
      login: 'operador',
      owners: ['operador', 'mi-organizacion', 'otra-org'],
      name: 'tienda',
      operation: 'create',
    });
    expect(run).toHaveBeenCalledWith('gh', ['auth', 'status', '--hostname', 'github.com'], root);
    expect(run.mock.calls.find(([, args]) => args.includes('user/orgs'))?.[1]).toContain(
      '--paginate',
    );
    expect(run.mock.calls.some(([, args]) => args.includes('create'))).toBe(false);
  });
  it.each([
    ['ENOENT', 'gh_missing'],
    [1, 'unauthenticated'],
  ])('explains unavailable auth %s without propagating output', async (code, errorCode) => {
    override = async () => failed('ghp_secret-value', code);
    expect(await request()).toMatchObject({ errorCode });
    expect(
      githubHostingErrorText(errorCode === 'gh_missing' ? 'gh_missing' : 'unauthenticated'),
    ).toContain('gh auth login');
  });
  it.each(markers)('denies managed process %s before filesystem or commands', async (marker) => {
    vi.stubEnv(marker, '');
    const project = vi.mocked(company.companyWorkspaceRoot);
    expect(await request()).toMatchObject({ errorCode: 'denied' });
    expect(await confirm('fake')).toMatchObject({ errorCode: 'denied' });
    expect(project).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it('denies missing operator privilege and client authority or token fields', async () => {
    expect(await request('requestGithubHosting', {}, false)).toMatchObject({ errorCode: 'denied' });
    for (const field of ['actor', 'token'])
      expect(await request('requestGithubHosting', { [field]: 'human' })).toMatchObject({
        errorCode: 'invalid_request',
      });
    expect(run).not.toHaveBeenCalled();
  });
  it('rejects a mismatched project before executing commands', async () => {
    expect(await request('requestGithubHosting', { projectId: 'other' })).toMatchObject({
      errorCode: 'unknown_project',
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('SA-146 single-use creation', () => {
  it('creates in an organization with public visibility then pushes existing commits', async () => {
    const { confirmationId } = await options();
    expect(
      await confirm(confirmationId, { owner: 'mi-organizacion', visibility: 'public' }),
    ).toMatchObject({ status: 'published' });
    expect(run).toHaveBeenCalledWith(
      'gh',
      [
        'repo',
        'create',
        'mi-organizacion/tienda',
        '--public',
        '--source',
        root,
        '--remote',
        'origin',
      ],
      root,
    );
    expect(run.mock.calls.some(([, args]) => args.includes('push'))).toBe(true);
    expect(run.mock.calls.some(([, args]) => args.includes('commit'))).toBe(false);
    expect(await confirm(confirmationId)).toMatchObject({ errorCode: 'confirmation_required' });
  });
  it('commits only the prepared manifest with configured identity when HEAD is unborn', async () => {
    head = 'unborn';
    expect(await confirm((await options()).confirmationId)).toMatchObject({ status: 'published' });
    const commit = run.mock.calls.find(([, args]) => args.includes('commit'))?.[1];
    expect(commit).toContain('--only');
    expect(commit?.slice(-2)).toEqual(['--', '.softwareagents/project.yaml']);
    const createIndex = run.mock.calls.findIndex(
      ([tool, args]) => tool === 'gh' && args[0] === 'repo',
    );
    expect(run.mock.calls.slice(0, createIndex).some(([, args]) => args.includes('commit'))).toBe(
      true,
    );
  });
  it('explains missing git identity before creation', async () => {
    head = 'unborn';
    const normal = override;
    override = (tool, args, cwd) =>
      args[0] === 'config' ? Promise.resolve(failed('missing')) : normal(tool, args, cwd);
    expect(await confirm((await options()).confirmationId)).toMatchObject({
      errorCode: 'identity_missing',
    });
    expect(run.mock.calls.some(([tool, args]) => tool === 'gh' && args[0] === 'repo')).toBe(false);
  });
  it.each([
    ['already exists', 'name_taken'],
    ['403 forbidden', 'permission_denied'],
    ['connection timed out', 'network'],
    ['401 bad credentials', 'unauthenticated'],
  ])('maps creation failure %s and consumes confirmation', async (stderr, errorCode) => {
    const normal = override;
    override = (tool, args, cwd) =>
      tool === 'gh' && args[0] === 'repo'
        ? Promise.resolve(failed(stderr))
        : normal(tool, args, cwd);
    const { confirmationId } = await options();
    expect(await confirm(confirmationId)).toMatchObject({ errorCode });
    expect(await confirm(confirmationId)).toMatchObject({ errorCode: 'confirmation_required' });
    expect(
      run.mock.calls.filter(([tool, args]) => tool === 'gh' && args[0] === 'repo'),
    ).toHaveLength(1);
    expect((await options()).confirmationId).not.toBe(confirmationId);
  });
  it('requires a new confirmation to resume a failed push and never recreates the repository', async () => {
    const normal = override;
    override = (tool, args, cwd) =>
      args.includes('push') ? Promise.resolve(failed('upload failed')) : normal(tool, args, cwd);
    const first = await options();
    expect(await confirm(first.confirmationId)).toMatchObject({ errorCode: 'push_failed' });
    expect(await confirm(first.confirmationId)).toMatchObject({
      errorCode: 'confirmation_required',
    });
    const retry = await options();
    expect(retry).toMatchObject({
      operation: 'push',
      owner: login,
      name: 'tienda',
      visibility: 'private',
    });
    override = normal;
    expect(await confirm(retry.confirmationId)).toMatchObject({ status: 'published' });
    expect(
      run.mock.calls.filter(([tool, args]) => tool === 'gh' && args[0] === 'repo'),
    ).toHaveLength(1);
  });
  it('rejects existing origin, changed account, invalid owners and shell-like names', async () => {
    remote = 'https://example.com/existing';
    expect(await request()).toMatchObject({ errorCode: 'origin_exists' });
    remote = '';
    const first = await options();
    login = 'otro';
    expect(await confirm(first.confirmationId, { owner: 'operador' })).toMatchObject({
      errorCode: 'account_changed',
    });
    expect(await confirm((await options()).confirmationId, { owner: 'intruso' })).toMatchObject({
      errorCode: 'invalid_request',
    });
    expect(
      await confirm((await options()).confirmationId, { name: '--public;echo secret' }),
    ).toMatchObject({ errorCode: 'invalid_request' });
  });
  it.each([
    ['network connection failed', 'network'],
    ['401 bad credentials', 'unauthenticated'],
    ['403 forbidden', 'permission_denied'],
  ])(
    'explains a failed push %s and retains confirmation-based recovery',
    async (stderr, errorCode) => {
      const normal = override;
      override = (tool, args, cwd) =>
        args.includes('push') ? Promise.resolve(failed(stderr)) : normal(tool, args, cwd);
      expect(await confirm((await options()).confirmationId)).toMatchObject({ errorCode });
      expect(await options()).toMatchObject({ operation: 'push' });
    },
  );
  it('rejects a replaced push destination before resuming a failed upload', async () => {
    const normal = override;
    override = (tool, args, cwd) =>
      args.includes('push') ? Promise.resolve(failed('upload failed')) : normal(tool, args, cwd);
    await confirm((await options()).confirmationId);
    const retry = await options();
    remote = 'https://example.com/unexpected';
    expect(await confirm(retry.confirmationId)).toMatchObject({ errorCode: 'origin_exists' });
    expect(run.mock.calls.filter(([, args]) => args.includes('push'))).toHaveLength(1);
  });
  it('revalidates the selected project and managed-process ingress after slow account detection', async () => {
    const normal = override;
    const first = await options();
    override = async (tool, args, cwd) => {
      const result = await normal(tool, args, cwd);
      if (args.includes('user/orgs')) vi.stubEnv('SA_WORKER', '1');
      return result;
    };
    expect(await confirm(first.confirmationId)).toMatchObject({ errorCode: 'denied' });
    expect(run.mock.calls.some(([tool, args]) => tool === 'gh' && args[0] === 'repo')).toBe(false);
  });
  it('expires confirmations and consumes concurrent duplicates before starting commands', async () => {
    const first = await options();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + GITHUB_CONFIRMATION_TTL_MS);
    expect(await confirm(first.confirmationId)).toMatchObject({
      errorCode: 'confirmation_required',
    });
    vi.mocked(Date.now).mockRestore();
    const next = await options();
    const replies = await Promise.all([confirm(next.confirmationId), confirm(next.confirmationId)]);
    expect(replies.map((reply) => reply.errorCode)).toContain('busy');
    expect(
      run.mock.calls.filter(([tool, args]) => tool === 'gh' && args[0] === 'repo'),
    ).toHaveLength(1);
  });
  it('keeps credentials out of messages, audit, logs and command arguments', async () => {
    const token = 'ghp_never-expose-this-secret';
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    const normal = override;
    override = (tool, args, cwd) =>
      tool === 'gh' && args[0] === 'repo'
        ? Promise.resolve(failed(`403 forbidden ${token}`))
        : normal(tool, args, cwd);
    const result = await confirm((await options()).confirmationId);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(run.mock.calls)).not.toContain(token);
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    expect(JSON.stringify(error.mock.calls)).not.toContain(token);
    const auditDir = path.join(process.env.HOME!, '.pixel-agents');
    for (const file of fs.readdirSync(auditDir, { recursive: true })) {
      const target = path.join(auditDir, String(file));
      if (fs.statSync(target).isFile())
        expect(fs.readFileSync(target, 'utf8')).not.toContain(token);
    }
    expect(result.errorCode).toBe('permission_denied');
  });
});
