import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../extension/', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ['tabs']);
assert.equal(manifest.host_permissions, undefined);
assert.equal(manifest.content_scripts, undefined);
assert.ok(manifest.description.length <= 132);
assert.ok(/^\d+\.\d+\.\d+$/.test(manifest.version));
for (const path of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page]) {
  assert.ok((await stat(join(root, path))).isFile(), `Missing manifest entry: ${path}`);
}
for (const [size, path] of Object.entries(manifest.icons)) {
  const png = await readFile(join(root, path));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), Number(size));
  assert.equal(png.readUInt32BE(20), Number(size));
}
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await inspect(path); continue; }
    assert.ok(entry.isFile(), `Unexpected package entry: ${path}`);
    if (extname(path) === '.js') {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || `Syntax check failed: ${path}`);
      const source = await readFile(path, 'utf8');
      assert.ok(!/\b(?:eval|importScripts)\s*\(|new\s+Function\s*\(/.test(source), `Dynamic code in ${path}`);
    }
    if (extname(path) === '.html') {
      const html = await readFile(path, 'utf8');
      for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        assert.match(match[1], /\bsrc=["'][^"']+["']/);
        assert.equal(match[2].trim(), '', `Inline script in ${path}`);
        assert.ok(!/\bsrc=["'](?:https?:)?\/\//i.test(match[1]), `Remote script in ${path}`);
      }
      assert.ok(!/\son[a-z]+\s*=/i.test(html), `Inline event handler in ${path}`);
    }
  }
}
await inspect(root);
console.log(`Manifest, permissions, icons, and extension syntax passed (${manifest.version}).`);
