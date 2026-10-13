import test from 'node:test';
import assert from 'node:assert/strict';
import { inventory, plan, shards, validateReceipts, largeFile } from '../../scripts/ci-plan.mjs';

test('CI assigns every current and new file exactly once per full lane and rejects duplicate or empty shards', () => {
  const lanes = plan(), all = inventory();
  for (const prefix of ['linux-22-', 'linux-24-', 'linux-26-', 'mac-22-']) {
    const assigned = lanes.filter(l => l.id.startsWith(prefix)).flatMap(l => l.files).sort();
    assert.deepEqual(assigned, all);
    assert.equal(new Set(assigned).size, all.length);
  }
  assert.ok(shards(['new.test.ts', 'old.test.ts'], {}, 2).flat().includes('new.test.ts'));
  assert.throws(() => shards(['same', 'same'], {}, 1));
  assert.throws(() => shards(['one'], {}, 2));
  assert.equal(lanes.filter(l => l.os === 'macos-latest').length, 5);
});

test('CI gate rejects missing, duplicate, wrong identity, failed and lost actual-large receipts', () => {
  const lanes = plan();
  const receipts = lanes.map(l => ({ id: l.id, sha: 'sha', node: l.node, platform: l.os.startsWith('mac') ? 'darwin' : 'linux',
    files: l.files, exit: 0, large: l.large, started: 1000, finished: 2000, sea: l.sea, benchmark: l.benchmark, foundation: l.foundation,
    arch: 'arm64', pathNode: l.node, input: { commit: 'sha', tree: 'tree', dirty: false },
    ...(l.files.includes(largeFile) ? { cap: { canonicalBytes: l.large ? 133_000_000 : 33_000_000, count: l.large ? 6_000_000 : 1_500_000 } } : {}) }));
  assert.equal(validateReceipts(lanes, receipts, 'sha').testWindowSeconds, 1);
  assert.throws(() => validateReceipts(lanes, receipts.slice(1), 'sha'));
  assert.throws(() => validateReceipts(lanes, [...receipts.slice(1), receipts[1]], 'sha'));
  for (const change of [{ sha: 'other' }, { node: '25.0.0' }, { platform: 'wrong' }, { exit: 1 }, { files: [] }]) {
    assert.throws(() => validateReceipts(lanes, [{ ...receipts[0], ...change }, ...receipts.slice(1)], 'sha'));
  }
  const large = receipts.findIndex(r => r.large);
  const lost = receipts.map((r, i) => i === large ? { ...r, large: false, cap: { canonicalBytes: 33_000_000, count: 1_500_000 } } : r);
  assert.throws(() => validateReceipts(lanes, lost, 'sha'), 'private test environment must retain the large cap');
});
