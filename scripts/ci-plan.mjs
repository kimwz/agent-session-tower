import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const versions = { '22': '22.22.3', '24': '24.15.0', '26': '26.0.0' };
export function inventory(root = '.') {
  const walk = path => readdirSync(join(root, path), { withFileTypes: true }).flatMap(item =>
    item.isDirectory() ? walk(`${path}/${item.name}`) : item.name.endsWith('.test.ts') ? [`${path}/${item.name}`] : []);
  return walk('tests').sort();
}

export function projectedSeconds(files, costs, concurrency) {
  const slots = Array.from({ length: concurrency }, () => 0);
  for (const file of [...files].sort()) {
    const next = slots.indexOf(Math.min(...slots));
    slots[next] += Math.max(costs[file] ?? 1, 1) + 1;
  }
  return Math.max(...slots);
}

export function shards(files, costs, count, concurrency = 4) {
  assert.ok(Number.isInteger(count) && count > 0);
  assert.equal(new Set(files).size, files.length, 'duplicate inventory');
  const bins = Array.from({ length: count }, () => ({ files: [] }));
  const cost = file => Math.max(costs[file] ?? 1, 1) + 1;
  for (const file of [...files].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0))) {
    const bin = bins.find(candidate => !candidate.files.length) ?? bins.reduce((best, candidate) => projectedSeconds([...candidate.files, file], costs, concurrency) < projectedSeconds([...best.files, file], costs, concurrency) ? candidate : best);
    bin.files.push(file);
  }
  assert.ok(bins.every(bin => bin.files.length), 'empty shard');
  return bins.map(bin => bin.files.sort());
}

// The former residual-probe files, also run on the Node 26 macOS compatibility lane.
const residual = [
  'decisions/service', 'http/storage-health', 'permissions/permissions', 'runs/run-instructions', 'runs/run-manager', 'runs/runner-steering',
  'runs/runner-update-drain', 'runs/endpoint-keeper', 'slack/backup', 'triggers/engine-format',
  'triggers/github-issue-watch', 'triggers/http', 'triggers/layering',
].map(path => `tests/server/${path}.test.ts`);
// The storage consumers each macOS compatibility lane runs beside tests/server/storage/.
const consumers = ['tests/server/sessions/retention-storage.test.ts', 'tests/server/runs/actual-run-storage.test.ts',
  'tests/server/runs/storage-diagnostic-worker.test.ts', 'tests/server/terminals/terminal-host.test.ts'];

export function plan(root = '.') {
  const files = inventory(root);
  const weights = JSON.parse(readFileSync(join(root, 'scripts/ci-test-costs.json'), 'utf8'));
  const lanes = [];
  for (const [os, major, count] of [['ubuntu-latest', '22', 4], ['ubuntu-latest', '24', 4], ['ubuntu-latest', '26', 4], ['macos-latest', '22', 3]]) {
    const index = os === 'macos-latest' ? 0 : major === '22' ? 1 : 2;
    const costs = Object.fromEntries(Object.entries(weights).map(([file, values]) => [file, values[index]]));
    const concurrency = os === 'macos-latest' ? 2 : 4;
    const assigned = shards(files, costs, count, concurrency);
    const cheapest = assigned.map(selected => projectedSeconds(selected, costs, concurrency));
    const foundation = cheapest.indexOf(Math.min(...cheapest));
    assigned.forEach((selected, shard) => lanes.push({ id: `${os.startsWith('mac') ? 'mac' : 'linux'}-${major}-${shard}`,
      // The first Linux Node 26 shard also builds and runs the standalone executable (scripts/test-executable.mjs).
      os, node: versions[major], foundation: shard === foundation, kind: 'full', major, shard, count, files: selected,
      sea: major === '26' && os === 'ubuntu-latest' && shard === 0 }));
  }
  for (const major of ['24', '26']) {
    const selected = [...new Set([...files.filter(path => path.startsWith('tests/server/storage/')), ...consumers,
      ...(major === '26' ? residual : [])])].sort();
    assert.ok(selected.every(path => files.includes(path)), 'compatibility file missing');
    lanes.push({ id: `mac-${major}`, os: 'macos-latest', node: versions[major], major, kind: 'compat', foundation: true, files: selected,
      sea: major === '26' });
  }
  return lanes;
}

/**
 * The lanes a tier runs (see scripts/ci-scope.mjs). `related` is browser code, which has no platform branches: the Node 22
 * floor's full inventory on Linux.
 */
export function lanesFor(tier, lanes = plan()) {
  if (tier === 'full') return lanes;
  if (tier === 'related') return lanes.filter(lane => lane.kind === 'full' && lane.major === '22' && lane.os === 'ubuntu-latest');
  if (tier === 'quick') return [];
  throw new Error(`unknown CI tier: ${tier}`);
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
    assert.ok(Number.isFinite(receipt.started) && receipt.finished > receipt.started, 'missing test interval');
    assert.equal(receipt.sea, lane.sea, 'missing actual SEA qualification');
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

/**
 * The checks job's receipt, written only once typecheck, the release checks and the quick suite have all passed, so it
 * always reports success (`exit: 0`, `quick: true`); a failure before that leaves no receipt and the gate fails on it.
 */
export function checksReceipt({ id, sha, input, admitted, ready }, started, finished) {
  return { id, sha, input, admitted, ready, started, finished, exit: 0, quick: true };
}

/**
 * The tests that took a second or more, from every lane's receipt (`slow`, written by scripts/ci-run.mjs from
 * scripts/test-durations.mjs): one entry per file and test name with its time on each lane, slowest first. Reporting only;
 * a lane without the list (or with a malformed one) adds nothing and fails nothing.
 */
export function slowTestReport(receipts) {
  const tests = new Map();
  for (const receipt of receipts) {
    if (!Array.isArray(receipt.slow)) continue;
    for (const test of receipt.slow) {
      if (typeof test?.name !== 'string' || !Number.isFinite(test.ms)) continue;
      const key = `${test.file}\n${test.name}`;
      const entry = tests.get(key) ?? { file: test.file, name: test.name, maxMs: 0, lanes: {} };
      entry.lanes[receipt.id] = Math.max(entry.lanes[receipt.id] ?? 0, test.ms);
      entry.maxMs = Math.max(entry.maxMs, test.ms);
      tests.set(key, entry);
    }
  }
  return [...tests.values()].sort((a, b) => b.maxMs - a.maxMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
