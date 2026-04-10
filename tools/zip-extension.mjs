import { createWriteStream, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Buffer } from 'node:buffer';

// Minimal ZIP creator — no external deps needed
// Produces a valid ZIP archive of the extension/ folder

const SRC = join(import.meta.dirname, '..', 'extension');
const OUT = join(import.meta.dirname, '..', 'autozalo-extension.zip');

function collectFiles(dir, base = dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectFiles(full, base));
    } else {
      results.push({ path: relative(base, full).replace(/\\/g, '/'), data: readFileSync(full) });
    }
  }
  return results;
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() >> 1) & 0x1F);
  const day = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F);
  return { time, day };
}

const files = collectFiles(SRC);
const now = new Date();
const { time, day } = dosDateTime(now);

const localHeaders = [];
const centralHeaders = [];
let offset = 0;

for (const file of files) {
  const nameBytes = Buffer.from(file.path, 'utf8');
  const crc = crc32(file.data);
  const size = file.data.length;

  // Local file header (30 + name + data)
  const local = Buffer.alloc(30 + nameBytes.length + size);
  local.writeUInt32LE(0x04034B50, 0);   // signature
  local.writeUInt16LE(20, 4);            // version needed
  local.writeUInt16LE(0, 6);             // flags
  local.writeUInt16LE(0, 8);             // compression (store)
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(size, 18);         // compressed
  local.writeUInt32LE(size, 22);         // uncompressed
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);            // extra length
  nameBytes.copy(local, 30);
  file.data.copy(local, 30 + nameBytes.length);
  localHeaders.push(local);

  // Central directory header (46 + name)
  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014B50, 0);
  central.writeUInt16LE(20, 4);           // version made by
  central.writeUInt16LE(20, 6);           // version needed
  central.writeUInt16LE(0, 8);            // flags
  central.writeUInt16LE(0, 10);           // compression
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(day, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(size, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30);           // extra
  central.writeUInt16LE(0, 32);           // comment
  central.writeUInt16LE(0, 34);           // disk
  central.writeUInt16LE(0, 36);           // internal attrs
  central.writeUInt32LE(0, 38);           // external attrs
  central.writeUInt32LE(offset, 42);      // local header offset
  nameBytes.copy(central, 46);
  centralHeaders.push(central);

  offset += local.length;
}

const centralSize = centralHeaders.reduce((s, b) => s + b.length, 0);

// End of central directory (22 bytes)
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054B50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralSize, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const stream = createWriteStream(OUT);
for (const buf of localHeaders) stream.write(buf);
for (const buf of centralHeaders) stream.write(buf);
stream.end(eocd);

stream.on('finish', () => {
  const totalSize = (offset + centralSize + 22);
  console.log(`[zip-extension] ${files.length} files → public/autozalo-extension.zip (${(totalSize / 1024).toFixed(1)} KB)`);
});
