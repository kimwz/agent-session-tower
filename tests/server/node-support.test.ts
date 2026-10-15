import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { NODE_LINES, nodeSupported } from '../../bin/node-support.mjs';
import { VERIFIED_NODE_LINES } from '../../server/storage/runtime.js';

test('the bin starts only on the Node.js releases package.json engines and the storage runtime check name', async () => {
  for (const version of ['22.22.3', '22.23.0', '24.15.0', '24.16.1', '26.0.0', '26.7.0']) assert.equal(nodeSupported(version), true, version);
  for (const version of ['22.22.2', '22.13.0', '24.14.9', '23.11.0', '25.9.0', '27.0.0', '20.19.0', '18.20.4']) assert.equal(nodeSupported(version), false, version);
  assert.deepEqual(NODE_LINES, VERIFIED_NODE_LINES);
  const { engines } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { engines: { node: string } };
  assert.equal(engines.node, Object.entries(NODE_LINES).map(([major, first]) => `>=${first} <${Number(major) + 1}`).join(' || '));
});
