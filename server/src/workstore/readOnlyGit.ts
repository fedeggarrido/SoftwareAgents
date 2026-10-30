import * as fs from 'node:fs';
import * as path from 'node:path';
import { inflateSync } from 'node:zlib';

import { resolveInside } from '../pathGuard.js';

/** SHA-1 object reader for loose objects and v2 pack indexes. Never invokes Git. */
export function gitObjectReader(common: string): (sha: string) => Buffer {
  const objects = resolveInside(common, 'objects');
  const cache = new Map<string, Buffer>();
  const active = new Set<string>();
  const indexes: Buffer[] = [];
  const packs: string[] = [];
  const packData = new Map<string, Buffer>();
  const packDir = resolveInside(objects, 'pack');
  if (fs.existsSync(packDir)) {
    for (const name of fs.readdirSync(packDir)) {
      // `git maintenance` (loose-objects task) writes loose-<hash>.pack beside pack-<hash>.pack;
      // ignoring it hid merged commits, so merged features looked unmerged.
      if (!/^(?:pack|loose)-[a-f0-9]{40}\.idx$/.test(name)) continue;
      const index = fs.readFileSync(resolveInside(packDir, name));
      if (index.readUInt32BE(0) !== 0xff744f63 || index.readUInt32BE(4) !== 2) continue;
      indexes.push(index);
      packs.push(resolveInside(packDir, name.replace(/\.idx$/, '.pack')));
    }
  }
  function delta(base: Buffer, patch: Buffer): Buffer {
    let cursor = 0;
    const byte = () => {
      if (cursor >= patch.length) throw new Error('Truncated delta');
      return patch[cursor++];
    };
    const size = () => {
      let value = 0;
      let shift = 0;
      let b: number;
      do {
        b = byte();
        value += (b & 0x7f) * 2 ** shift;
        shift += 7;
        if (shift > 49) throw new Error('Invalid delta size');
      } while (b & 0x80);
      return value;
    };
    if (size() !== base.length) throw new Error('Invalid delta base');
    const resultSize = size();
    const chunks: Buffer[] = [];
    let length = 0;
    while (cursor < patch.length) {
      const command = byte();
      let chunk: Buffer;
      if (command & 0x80) {
        let offset = 0;
        let count = 0;
        for (let i = 0; i < 4; i++) if (command & (1 << i)) offset += byte() * 2 ** (i * 8);
        for (let i = 0; i < 3; i++) if (command & (1 << (i + 4))) count += byte() * 2 ** (i * 8);
        count ||= 0x10000;
        if (offset + count > base.length) throw new Error('Invalid delta copy');
        chunk = base.subarray(offset, offset + count);
      } else {
        if (!command || cursor + command > patch.length) throw new Error('Invalid delta insert');
        chunk = patch.subarray(cursor, cursor + command);
        cursor += command;
      }
      chunks.push(chunk);
      length += chunk.length;
      if (length > resultSize) throw new Error('Invalid delta length');
    }
    if (length !== resultSize) throw new Error('Invalid delta result');
    return Buffer.concat(chunks);
  }
  function unpack(pack: Buffer, offset: number, depth = 0): Buffer {
    if (depth > 128 || offset < 12 || offset >= pack.length) throw new Error('Invalid pack offset');
    let cursor = offset;
    let header = pack[cursor++];
    const type = (header >> 4) & 7;
    while (header & 0x80) header = pack[cursor++];
    let base: Buffer | undefined;
    if (type === 6) {
      let b = pack[cursor++];
      let distance = b & 0x7f;
      while (b & 0x80) {
        b = pack[cursor++];
        distance = (distance + 1) * 128 + (b & 0x7f);
      }
      base = unpack(pack, offset - distance, depth + 1);
    } else if (type === 7) {
      base = read(pack.subarray(cursor, cursor + 20).toString('hex'));
      cursor += 20;
    } else if (type !== 1) {
      throw new Error('Expected commit object');
    }
    const data = inflateSync(pack.subarray(cursor));
    return base ? delta(base, data) : data;
  }
  function read(sha: string): Buffer {
    if (!/^[a-f0-9]{40}$/i.test(sha) || active.has(sha)) throw new Error('Invalid object');
    const cached = cache.get(sha);
    if (cached) return cached;
    active.add(sha);
    try {
      const loose = path.join(objects, sha.slice(0, 2), sha.slice(2));
      let data: Buffer | undefined;
      if (fs.existsSync(loose)) {
        const object = inflateSync(
          fs.readFileSync(resolveInside(objects, `${sha.slice(0, 2)}/${sha.slice(2)}`)),
        );
        const separator = object.indexOf(0);
        if (!object.subarray(0, separator).toString().startsWith('commit '))
          throw new Error('Expected commit');
        data = object.subarray(separator + 1);
      } else {
        const id = Buffer.from(sha, 'hex');
        for (let p = 0; p < indexes.length && !data; p++) {
          const index = indexes[p];
          const count = index.readUInt32BE(8 + 255 * 4);
          let low = 0;
          let high = count - 1;
          while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const comparison = Buffer.compare(
              index.subarray(1032 + mid * 20, 1032 + (mid + 1) * 20),
              id,
            );
            if (comparison < 0) low = mid + 1;
            else if (comparison > 0) high = mid - 1;
            else {
              const entry = index.readUInt32BE(1032 + count * 24 + mid * 4);
              const offset =
                entry & 0x80000000
                  ? Number(index.readBigUInt64BE(1032 + count * 28 + (entry & 0x7fffffff) * 8))
                  : entry;
              let pack = packData.get(packs[p]);
              if (!pack) {
                pack = fs.readFileSync(packs[p]);
                packData.set(packs[p], pack);
              }
              data = unpack(pack, offset);
              break;
            }
          }
        }
      }
      if (!data) throw new Error('Object unavailable');
      cache.set(sha, data);
      return data;
    } finally {
      active.delete(sha);
    }
  }
  return read;
}
