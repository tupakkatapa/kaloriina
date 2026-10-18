// A zip of text files, built for tests (takeout.test.mjs, the Google
// Health spec): deflated unless `stored`. CRCs are left 0: no reader here
// checks them.

import { deflateRawSync } from "node:zlib";

export function makeZip(entries) {
  const parts = [];
  const dir = [];
  let offset = 0;
  for (const { name, text, stored } of entries) {
    const raw = Buffer.from(text);
    const data = stored ? raw : deflateRawSync(raw);
    const n = Buffer.from(name);
    const method = stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, n, data);
    dir.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const directory = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
