import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

await import('./check-package.mjs');
const root = fileURLToPath(new URL('../extension/', import.meta.url));
const destination = fileURLToPath(new URL('../dist/', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const entries = [];
async function collect(directory) {
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = join(directory, item.name);
    if (item.isDirectory()) await collect(path);
    else if (item.isFile()) entries.push({ name: relative(root, path).split(sep).join('/'), data: await readFile(path) });
    else throw new Error(`Package cannot include symlinks: ${path}`);
  }
}
await collect(root);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const local = [], central = [];
let offset = 0;
for (const entry of entries) {
  const name = Buffer.from(entry.name, 'utf8'), compressed = deflateRawSync(entry.data), crc = crc32(entry.data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(entry.data.length, 22); header.writeUInt16LE(name.length, 26);
  local.push(header, name, compressed);
  const index = Buffer.alloc(46);
  index.writeUInt32LE(0x02014b50, 0); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6);
  index.writeUInt16LE(0x800, 8); index.writeUInt16LE(8, 10); index.writeUInt16LE(33, 14);
  index.writeUInt32LE(crc, 16); index.writeUInt32LE(compressed.length, 20); index.writeUInt32LE(entry.data.length, 24);
  index.writeUInt16LE(name.length, 28); index.writeUInt32LE(offset, 42);
  central.push(index, name); offset += header.length + name.length + compressed.length;
}
const centralBytes = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...local, centralBytes, end]);
await mkdir(destination, { recursive: true });
const filename = `tab-harbor-${manifest.version}.zip`;
await writeFile(join(destination, filename), archive);
const sha256 = createHash('sha256').update(archive).digest('hex');
await writeFile(join(destination, `${filename}.sha256`), `${sha256}  ${filename}\n`);
console.log(`${filename}: ${entries.length} files, ${archive.length} bytes, SHA256 ${sha256}`);
