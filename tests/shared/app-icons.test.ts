import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const publicFile = (name: string) => new URL(`../../client/public/${name}`, import.meta.url);
const dimensions = (png: Buffer) => {
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
};
test('installed icons declare real raster dimensions and include a high-resolution original export', async () => {
  const manifest = JSON.parse(await readFile(publicFile('manifest.webmanifest'), 'utf8'));
  const sizes = [];
  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/png', 'the tab favicon contains a small bitmap, not scalable vector artwork');
    const file = icon.src.split('?')[0].replace(/^\//, '');
    assert.equal(dimensions(await readFile(publicFile(file))), icon.sizes);
    sizes.push(icon.sizes);
  }
  assert.ok(sizes.includes('192x192'));
  assert.ok(sizes.includes('512x512'));
  assert.ok(sizes.includes('1024x1024'));
  assert.equal(dimensions(await readFile(publicFile('apple-touch-icon.png'))), '1024x1024');
});
