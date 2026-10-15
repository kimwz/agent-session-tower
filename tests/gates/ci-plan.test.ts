import test from 'node:test';
import assert from 'node:assert/strict';
import { inventory, plan, shards, slowTestReport, validateReceipts } from '../../scripts/ci-plan.mjs';

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
  assert.deepEqual(lanes.filter(l => l.sea).map(l => l.id), ['linux-26-0', 'mac-26'], 'the standalone executable runs once per platform');
});

test('CI gate rejects missing, duplicate, wrong identity, failed and lost executable receipts', () => {
  const lanes = plan();
  const receipts = lanes.map(l => ({ id: l.id, sha: 'sha', node: l.node, platform: l.os.startsWith('mac') ? 'darwin' : 'linux',
    files: l.files, exit: 0, started: 1000, finished: 2000, sea: l.sea, foundation: l.foundation,
    arch: 'arm64', pathNode: l.node, input: { commit: 'sha', tree: 'tree', dirty: false } }));
  assert.equal(validateReceipts(lanes, receipts, 'sha').testWindowSeconds, 1);
  assert.throws(() => validateReceipts(lanes, receipts.slice(1), 'sha'));
  assert.throws(() => validateReceipts(lanes, [...receipts.slice(1), receipts[1]], 'sha'));
  for (const change of [{ sha: 'other' }, { node: '25.0.0' }, { platform: 'wrong' }, { exit: 1 }, { files: [] }]) {
    assert.throws(() => validateReceipts(lanes, [{ ...receipts[0], ...change }, ...receipts.slice(1)], 'sha'));
  }
  const sea = receipts.findIndex(r => r.sea);
  assert.throws(() => validateReceipts(lanes, receipts.map((r, i) => i === sea ? { ...r, sea: false } : r), 'sha'), 'the executable check must run');
});

test('the slow-test report merges every lane\'s tests of a second or more and ignores what it cannot read', () => {
  const report = slowTestReport([
    { id: 'linux-22-0', slow: [{ file: 'tests/a.test.ts', name: 'a', ms: 1500 }, { file: 'tests/b.test.ts', name: 'b', ms: 1000 }] },
    { id: 'mac-22-0', slow: [{ file: 'tests/a.test.ts', name: 'a', ms: 3000 }, { name: 'broken' } as never] },
    { id: 'linux-24-0' },
    { id: 'checks', slow: 'not a list' as never },
  ]);
  assert.deepEqual(report, [
    { file: 'tests/a.test.ts', name: 'a', maxMs: 3000, lanes: { 'linux-22-0': 1500, 'mac-22-0': 3000 } },
    { file: 'tests/b.test.ts', name: 'b', maxMs: 1000, lanes: { 'linux-22-0': 1000 } },
  ]);
});
