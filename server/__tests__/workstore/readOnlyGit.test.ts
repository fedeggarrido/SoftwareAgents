import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';

import { expect, it } from 'vitest';

import { readMainAncestors } from '../../src/workstore/readOnlyWorkStore.js';

it('follows packed commits, including REF_DELTA and OFS_DELTA, without Git processes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'features-pack-'));
  try {
    const common = path.join(root, '.git');
    const packDir = path.join(common, 'objects', 'pack');
    fs.mkdirSync(packDir, { recursive: true });
    const number = (value: number) => {
      const bytes: number[] = [];
      do {
        const b = value & 0x7f;
        value = Math.floor(value / 128);
        bytes.push(b | (value ? 0x80 : 0));
      } while (value);
      return Buffer.from(bytes);
    };
    const body = (parent?: string) =>
      Buffer.from(`tree ${'0'.repeat(40)}\n${parent ? `parent ${parent}\n` : ''}\nfixture\n`);
    const id = (data: Buffer) =>
      createHash('sha1')
        .update(Buffer.from(`commit ${data.length}\0`))
        .update(data)
        .digest('hex');
    const first = body();
    const second = body(id(first));
    const third = body(id(second));
    const entry = (type: number, data: Buffer, base = Buffer.alloc(0)) => {
      const header = [(type << 4) | (data.length & 15)];
      let remaining = Math.floor(data.length / 16);
      while (remaining) {
        header[header.length - 1] |= 0x80;
        header.push(remaining & 0x7f);
        remaining = Math.floor(remaining / 128);
      }
      return Buffer.concat([Buffer.from(header), base, deflateSync(data)]);
    };
    const delta = (base: Buffer, result: Buffer) =>
      Buffer.concat([
        number(base.length),
        number(result.length),
        // Copy the shared tree header, then insert the changed parent/message.
        Buffer.from([0x90, 46, result.length - 46]),
        result.subarray(46),
      ]);
    const a = entry(1, first);
    const b = entry(7, delta(first, second), Buffer.from(id(first), 'hex'));
    const distance = b.length;
    expect(distance).toBeLessThan(128);
    const c = entry(6, delta(second, third), Buffer.from([distance]));
    const packHeader = Buffer.alloc(12);
    packHeader.write('PACK');
    packHeader.writeUInt32BE(2, 4);
    packHeader.writeUInt32BE(3, 8);
    const pack = Buffer.concat([packHeader, a, b, c]);
    const checksum = createHash('sha1').update(pack).digest();
    const name = `pack-${checksum.toString('hex')}`;
    fs.writeFileSync(path.join(packDir, `${name}.pack`), Buffer.concat([pack, checksum]));
    const entries = [
      { sha: id(first), offset: 12 },
      { sha: id(second), offset: 12 + a.length },
      { sha: id(third), offset: 12 + a.length + b.length },
    ].sort((x, y) => x.sha.localeCompare(y.sha));
    const index = Buffer.alloc(1032 + entries.length * 28);
    index.writeUInt32BE(0xff744f63);
    index.writeUInt32BE(2, 4);
    for (let i = 0; i < 256; i++) {
      index.writeUInt32BE(
        entries.filter((e) => parseInt(e.sha.slice(0, 2), 16) <= i).length,
        8 + i * 4,
      );
    }
    entries.forEach((e, i) => {
      Buffer.from(e.sha, 'hex').copy(index, 1032 + i * 20);
      index.writeUInt32BE(e.offset, 1032 + entries.length * 24 + i * 4);
    });
    fs.writeFileSync(path.join(packDir, `${name}.idx`), index);
    fs.writeFileSync(path.join(common, 'packed-refs'), `${id(third)} refs/heads/main\n`);
    expect(readMainAncestors(root)).toEqual(new Set([id(first), id(second), id(third)]));
    fs.unlinkSync(path.join(packDir, `${name}.pack`));
    // A readable ref still proves equality, but missing parents are never guessed.
    expect(readMainAncestors(root)).toEqual(new Set([id(third)]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
