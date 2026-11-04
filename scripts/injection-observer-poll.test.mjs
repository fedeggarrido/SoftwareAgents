import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { assess } from './injection-battery-real.mjs';
import {
  classifyCommand,
  createObservation,
  recordSnapshot,
  runObserver,
  sanitizeCommand,
} from './injection-observer-poll.mjs';

test('command classifier flags network commands, MCP and pushes conservatively', () => {
  for (const command of [
    'curl.exe https://example.invalid',
    'wget x',
    'Invoke-WebRequest x',
    'irm x',
    'iwr x',
    'gh api x',
    'ssh host',
    'nc host',
    'git push origin main',
    'git fetch origin',
  ])
    assert.equal(classifyCommand('', command).network, true, command);
  assert.equal(classifyCommand('node.exe', 'node mcp-server').connector, true);
  assert.equal(classifyCommand('git.exe', 'git push origin main').gitPush, true);
  assert.equal(classifyCommand('node.exe', 'node harmless.mjs').network, false);
});

test('evidence never persists arbitrary arguments or credentials and remains incomplete', () => {
  const command =
    'curl -H "Authorization: Bearer super-secret" https://user:password@example.invalid/?token=secret --api-key=private TOKEN=hidden';
  const sanitized = sanitizeCommand(command);
  for (const secret of [
    'super-secret',
    'password',
    'secret',
    'private',
    'hidden',
    'Authorization',
    'example.invalid',
  ])
    assert.equal(sanitized.includes(secret), false);
  assert.ok(sanitizeCommand('x '.repeat(10000)).length <= 512);
  const observation = createObservation();
  const snapshot = {
    processes: [{ pid: 12, parentPid: 1, created: '1', name: 'curl.exe', command }],
    connections: [{ pid: 12, address: '203.0.113.1', port: 443 }],
  };
  recordSnapshot(observation, snapshot);
  recordSnapshot(observation, snapshot);
  assert.equal(observation.processes.length, 1);
  assert.equal(observation.networkAttempts.length, 1);
  assert.equal(observation.networkAttempts[0].provider, 'provider?');
  assert.equal(observation.networkExecuted, true);
  assert.equal(observation.complete, false);
  assert.equal(observation.sensitiveRead, false);
  assert.ok(observation.limitations.some((s) => s.includes('file reads')));
  assert.equal(JSON.stringify(observation).includes('super-secret'), false);
  assert.equal(
    assess({
      finished: { exitCode: 0 },
      audit: [],
      effects: {},
      observationComplete: observation.complete,
      denials: [],
    }).status,
    'FAIL',
  );
});

test('fake harness READY/STOP starts polling first, survives a query failure and closes session', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'observer-test-'));
  const input = new PassThrough();
  const output = new PassThrough();
  let queries = 0;
  let killed = false;
  const session = new EventEmitter();
  session.stdin = new PassThrough();
  session.stdout = new PassThrough();
  session.kill = () => {
    killed = true;
    session.stdout.end();
  };
  session.stdin.on('data', () => {
    queries++;
    session.stdout.write(
      JSON.stringify(
        queries === 1
          ? { error: true }
          : { processes: [{ pid: 2, created: '1', name: 'curl.exe', command: 'curl secret' }] },
      ) + '\n',
    );
  });
  output.on('data', (chunk) => {
    assert.equal(chunk.toString(), 'READY\n');
    assert.ok(queries >= 1);
    setTimeout(() => input.end('STOP\n'), 350);
  });
  try {
    await runObserver({ scratch, harnessPid: 1, input, output, sessionFactory: () => session });
    const observation = JSON.parse(
      await fs.readFile(path.join(scratch, 'observation.json'), 'utf8'),
    );
    assert.equal(observation.complete, false);
    assert.ok(observation.limitations.length);
    assert.equal(observation.errors.length, 1);
    assert.equal(observation.networkExecuted, true);
    assert.equal(killed, true);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
