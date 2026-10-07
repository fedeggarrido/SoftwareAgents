import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SERVER_DISCOVERY_LOCK_LEASE_MS } from '../src/constants.js';

vi.mock('fs', async () => ({ ...(await vi.importActual<typeof import('fs')>('fs')) }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => process.env['HOME']! };
});
const { withDiscoveryLock, writeDiscoveryRecord } = await import('../src/discoveryRecords.js');
let home: string;
let dir: string;
let lock: string;
const nonce = '12345678-1234-1234-1234-123456789abc';
const nextNonce = '12345678-1234-1234-1234-123456789def';
const owner = (pid: number, value = nonce) => JSON.stringify({ pid, nonce: value });
function expire(file: string): void {
  const old = new Date(Date.now() - SERVER_DISCOVERY_LOCK_LEASE_MS - 1000);
  fs.utimesSync(file, old, old);
}

describe('discovery lease and publication primitives', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-lease-'));
    vi.stubEnv('HOME', home);
    dir = path.join(home, '.pixel-agents', 'servers');
    fs.mkdirSync(dir, { recursive: true });
    lock = path.join(dir, '.discovery.lock');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.each(['', 'invalid', owner(process.pid)])('recovers expired lock contents %j', (text) => {
    fs.writeFileSync(lock, text);
    expire(lock);
    expect(withDiscoveryLock(() => 'acquired')).toBe('acquired');
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readdirSync(dir).some((file) => file.startsWith('.reaped-'))).toBe(true);
  });

  it.each(['', 'invalid'])('leaves a recent incomplete lock %j until its lease expires', (text) => {
    fs.writeFileSync(lock, text);
    expect(() => withDiscoveryLock(() => 'unreachable')).toThrow('Discovery lock timed out');
    expect(fs.readFileSync(lock, 'utf8')).toBe(text);
    expire(lock);
    withDiscoveryLock(() => {});
    expect(fs.existsSync(lock)).toBe(false);
  });

  it.each(['dead', 'expired-live', 'expired-invalid', 'expired-empty'])(
    'elects a successor for a %s reaper tombstone',
    (kind) => {
      fs.writeFileSync(lock, owner(999999));
      const tombstone = path.join(dir, `.reaped-${nonce}.lock`);
      const text =
        kind === 'dead'
          ? owner(999999, nextNonce)
          : kind === 'expired-live'
            ? owner(process.pid, nextNonce)
            : kind === 'expired-empty'
              ? ''
              : 'invalid';
      fs.writeFileSync(tombstone, text);
      if (kind !== 'dead') expire(tombstone);
      withDiscoveryLock(() => {});
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.readFileSync(tombstone, 'utf8')).toBe(text);
      expect(fs.readdirSync(dir).filter((file) => file.startsWith('.reaped-'))).toHaveLength(2);
    },
  );

  it('two sequential reapers cannot reap the same generation twice or unlink its successor', () => {
    fs.writeFileSync(lock, owner(999999));
    withDiscoveryLock(() => {});
    const tombstone = fs.readFileSync(path.join(dir, `.reaped-${nonce}.lock`), 'utf8');
    // A delayed contender for this dead generation loses the existing election.
    fs.writeFileSync(lock, owner(999999));
    expect(() => withDiscoveryLock(() => {})).toThrow('Discovery lock timed out');
    expect(fs.readFileSync(lock, 'utf8')).toBe(owner(999999));
    // A successor's live lock is also protected by its own generation.
    fs.writeFileSync(lock, owner(process.pid, nextNonce));
    expect(() => withDiscoveryLock(() => {})).toThrow('Discovery lock timed out');
    expect(fs.readFileSync(lock, 'utf8')).toBe(owner(process.pid, nextNonce));
    expect(fs.readFileSync(path.join(dir, `.reaped-${nonce}.lock`), 'utf8')).toBe(tombstone);
  });

  it('releases its exclusive create after a failed body write', () => {
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file, ...args) => {
      if (typeof file === 'number') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return write(file, ...args);
    }) as typeof fs.writeFileSync);
    expect(() => withDiscoveryLock(() => {})).toThrow('disk full');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('releases its lock without rereading the body', () => {
    const read = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file, ...args) => {
      if (file === lock) throw Object.assign(new Error('unreadable'), { code: 'EPERM' });
      return read(file, ...args);
    }) as typeof fs.readFileSync);
    withDiscoveryLock(() => {});
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('releases its own inode even if its contents become incomplete', () => {
    withDiscoveryLock(() => fs.truncateSync(lock));
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('does not release a successor inode after its own lock was replaced', () => {
    withDiscoveryLock(() => {
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, owner(process.pid, nextNonce), { flag: 'wx' });
    });
    expect(fs.readFileSync(lock, 'utf8')).toBe(owner(process.pid, nextNonce));
  });

  it.each(['EPERM', 'EACCES', 'EBUSY', 'EBADF', 'ENOENT', 'containment'])(
    'retries %s during lock acquisition',
    (code) => {
      const open = fs.openSync;
      let failures = 3;
      vi.spyOn(fs, 'openSync').mockImplementation(((file, ...args) => {
        if (file === lock && failures-- > 0)
          throw Object.assign(
            new Error(code === 'containment' ? 'Path must stay inside its root' : code),
            code === 'containment' ? {} : { code },
          );
        return open(file, ...args);
      }) as typeof fs.openSync);
      expect(withDiscoveryLock(() => 'ok')).toBe('ok');
      expect(fs.existsSync(lock)).toBe(false);
    },
  );

  it.each(['EPERM', 'EBUSY'])('retries a transient %s rename', (code) => {
    const rename = fs.renameSync;
    let failures = 3;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (failures-- > 0) throw Object.assign(new Error(code), { code });
      rename(from, to);
    });
    const record = { pid: process.pid, port: 1234, token: 'test' };
    withDiscoveryLock(() => writeDiscoveryRecord('server.json', record));
    expect(
      JSON.parse(fs.readFileSync(path.join(home, '.pixel-agents', 'server.json'), 'utf8')),
    ).toEqual(record);
    expect(
      fs.readdirSync(path.join(home, '.pixel-agents')).some((file) => file.endsWith('.tmp')),
    ).toBe(false);
  });
});
