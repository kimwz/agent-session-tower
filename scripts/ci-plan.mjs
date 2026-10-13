import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const versions = { '22': '22.22.3', '24': '24.15.0', '26': '26.0.0' };
export const largeFile = 'tests/server/sessions/retention-storage.test.ts';
export const offlineFile = 'tests/server/link/storage-offline-activation.test.ts';
export function inventory(root = '.') {
  const walk = path => readdirSync(join(root, path), { withFileTypes: true }).flatMap(item =>
    item.isDirectory() ? walk(`${path}/${item.name}`) : item.name.endsWith('.test.ts') ? [`${path}/${item.name}`] : []);
  return walk('tests').sort();
}

export function projectedSeconds(files, costs, concurrency, tails = {}) {
  const slots = Array.from({ length: concurrency }, () => 0);
  for (const file of [...files].sort()) {
    const next = slots.indexOf(Math.min(...slots));
    slots[next] += Math.max(costs[file] ?? 1, 1) + 1;
  }
  return Math.max(...slots) + files.reduce((sum, file) => sum + (tails[file] ?? 0), 0);
}

export function shards(files, costs, count, concurrency = 4, tails = {}) {
  assert.ok(Number.isInteger(count) && count > 0);
  assert.equal(new Set(files).size, files.length, 'duplicate inventory');
  const bins = Array.from({ length: count }, () => ({ files: [] }));
  const cost = file => Math.max(costs[file] ?? 1, 1) + 1;
  for (const file of [...files].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0))) {
    const bin = bins.find(candidate => !candidate.files.length) ?? bins.reduce((best, candidate) => projectedSeconds([...candidate.files, file], costs, concurrency, tails) < projectedSeconds([...best.files, file], costs, concurrency, tails) ? candidate : best);
    bin.files.push(file);
  }
  assert.ok(bins.every(bin => bin.files.length), 'empty shard');
  return bins.map(bin => bin.files.sort());
}

const residual = [
  'decisions/service', 'http/storage-health', 'link/storage-update-legacy', 'link/storage-web',
  'permissions/permissions', 'runs/run-instructions', 'runs/run-manager', 'runs/runner-steering',
  'runs/runner-update-drain', 'runs/endpoint-keeper', 'slack/backup', 'triggers/engine-format',
  'triggers/github-issue-watch', 'triggers/http', 'triggers/layering',
].map(path => `tests/server/${path}.test.ts`);
const consumers = [largeFile, offlineFile, 'tests/server/runs/actual-run-storage.test.ts',
  'tests/server/runs/storage-diagnostic-worker.test.ts', 'tests/server/terminals/terminal-host.test.ts'];

export function plan(root = '.') {
  const files = inventory(root);
  const weights = JSON.parse(readFileSync(join(root, 'scripts/ci-test-costs.json'), 'utf8'));
  const lanes = [];
  for (const [os, major, count] of [['ubuntu-latest', '22', 4], ['ubuntu-latest', '24', 4], ['ubuntu-latest', '26', 4], ['macos-latest', '22', 3]]) {
    const index = os === 'macos-latest' ? 0 : major === '22' ? 1 : 2;
    const costs = Object.fromEntries(Object.entries(weights).map(([file, values]) => [file, values[index]]));
    // The designated full lane also retains the largest numeric expansion and comparison benchmark.
    const concurrency = os === 'macos-latest' ? 2 : 4;
    const tails = major === '24' ? { [largeFile]: 90 } : major === '26' ? { [offlineFile]: 30 } : {};
    const assigned = shards(files, costs, count, concurrency, tails);
    const cheapest = assigned.map(selected => projectedSeconds(selected, costs, concurrency, tails));
    const foundation = cheapest.indexOf(Math.min(...cheapest));
    assigned.forEach((selected, shard) => lanes.push({ id: `${os.startsWith('mac') ? 'mac' : 'linux'}-${major}-${shard}`,
      os, node: versions[major], foundation: shard === foundation, kind: 'full', major, shard, count, files: selected,
      large: major === '24' && selected.includes(largeFile), sea: major === '26' && selected.includes(offlineFile),
      benchmark: major === '24' && selected.includes(largeFile) }));
  }
  for (const major of ['24', '26']) {
    const selected = [...new Set([...files.filter(path => path.startsWith('tests/server/storage/')), ...consumers, ...files.filter(path => /storage-offline-service-\d+\.test\.ts$/.test(path)),
      ...(major === '26' ? residual : [])])].sort();
    assert.ok(selected.every(path => files.includes(path)), 'compatibility file missing');
    lanes.push({ id: `mac-${major}`, os: 'macos-latest', node: versions[major], major, kind: 'compat', foundation: true, files: selected,
      large: false, sea: major === '26', benchmark: false });
  }
  return lanes;
}

export function validateReceipts(lanes, receipts, sha) {
  assert.equal(receipts.length, lanes.length, 'missing/extra lane receipt');
  assert.equal(new Set(receipts.map(r => r.id)).size, receipts.length, 'duplicate receipt');
  for (const lane of lanes) {
    const receipt = receipts.find(r => r.id === lane.id);
    assert.ok(receipt, `missing ${lane.id}`);
    assert.equal(receipt.sha, sha, 'wrong tested SHA');
    assert.equal(receipt.node, lane.node, 'wrong tested Node');
    assert.equal(receipt.platform, lane.os.startsWith('mac') ? 'darwin' : 'linux', 'wrong OS');
    assert.deepEqual(receipt.files, lane.files, 'test file coverage changed');
    assert.equal(receipt.exit, 0, `failed ${lane.id}`);
    assert.equal(receipt.large, lane.large, 'large environment was lost');
    assert.ok(Number.isFinite(receipt.started) && receipt.finished > receipt.started, 'missing test interval');
    if (lane.files.includes(largeFile)) {
      assert.ok(receipt.cap?.canonicalBytes > (lane.large ? 132_000_000 : 32_000_000), 'actual canonical boundary was not exercised');
      assert.equal(receipt.cap.count, lane.large ? 6_000_000 : 1_500_000);
    }
    assert.equal(receipt.sea, lane.sea, 'missing actual SEA qualification');
    assert.equal(receipt.benchmark, lane.benchmark, 'missing retention benchmark');
    assert.equal(receipt.foundation, lane.foundation, 'missing core durability sample');
    if (lane.os.startsWith('mac')) {
      assert.equal(receipt.arch, 'arm64', 'wrong Mac architecture');
      assert.equal(receipt.pathNode, lane.node, 'child Node differs');
      assert.ok(receipt.input && receipt.input.dirty === false, 'Mac source not clean');
    }
  }
  return { testWindowSeconds: (Math.max(...receipts.map(r => r.finished)) - Math.min(...receipts.map(r => r.started))) / 1000,
    testRunnerSeconds: receipts.reduce((sum, r) => sum + (r.finished - r.started) / 1000, 0) };
}
