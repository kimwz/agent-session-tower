import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { plan, validateReceipts } from './ci-plan.mjs';
import { testedInput } from './ci-input.mjs';

assert.equal(process.platform, 'darwin', 'owner Mac only; not a persistent self-hosted runner');
const [action, destination, toolchains] = process.argv.slice(2);
const record = resolve(destination), manifestPath = join(record, 'local-run.json');
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
const run = (node, args, cwd, env, log) => new Promise((accept, reject) => {
  const fd = openSync(log, 'w', 0o600);
  const child = spawn(node, args, { cwd, env, stdio: ['ignore', fd, fd] });
  child.once('error', error => { closeSync(fd); reject(error); });
  child.once('close', code => { closeSync(fd); code === 0 ? accept() : reject(new Error(`${cwd}: exit ${code}; see ${log}`)); });
});
// Each batch leaves ~1.4 GB per commit (worktrees, npm/fixture sandboxes, TMPDIR). Once a batch ends, keep only
// the record (logs, setup.json, receipts, reports) and remove what prepare built; re-running needs a new prepare.
const inside = (path, root) => path.startsWith(`${root}/`);
const release = batch => {
  for (const lane of batch.lanes) {
    const jobDir = join(record, 'jobs', `ci-${lane.id}`), setupPath = join(jobDir, 'setup.json');
    const tmp = existsSync(setupPath) ? JSON.parse(readFileSync(setupPath, 'utf8')).env.TMPDIR : undefined;
    for (const name of existsSync(jobDir) ? readdirSync(jobDir).filter(n => n.startsWith('private-')) : []) {
      const reports = join(jobDir, name, 'reports'), kept = join(jobDir, 'reports');
      if (existsSync(reports) && !existsSync(kept)) renameSync(reports, kept);
      rmSync(join(jobDir, name), { recursive: true, force: true });
    }
    if (tmp?.startsWith('/private/tmp/tci-')) rmSync(tmp, { recursive: true, force: true });
    if (inside(lane.cwd, batch.executionRoot) && existsSync(lane.cwd)) git(['worktree', 'remove', '--force', lane.cwd]);
  }
  if (batch.executionRoot.startsWith('/private/tmp/tower-ci-worktrees-')) rmSync(batch.executionRoot, { recursive: true, force: true });
  git(['worktree', 'prune']);
};
const releaseAfter = batch => {
  try { release(batch); } catch (error) { console.error(`cleanup incomplete: ${error.message}; run: ci-local-mac.mjs clean ${record}`); }
};

if (action === 'prepare') {
  mkdirSync(record, { recursive: true, mode: 0o700 });
  const input = testedInput();
  const executionRoot = mkdtempSync('/private/tmp/tower-ci-worktrees-');
  const lanes = plan().filter(l => l.os === 'macos-latest').map(lane => ({ ...lane,
    cwd: join(executionRoot, `worktree-${lane.id}`), nodePath: resolve(toolchains, `node-v${lane.node}-darwin-arm64`, 'bin', 'node') }));
  const batch = { input, executionRoot, admitted: Date.now(), lanes };
  writeFileSync(manifestPath, JSON.stringify(batch, null, 2));
  try {
    for (const lane of lanes) {
      git(['worktree', 'add', '--detach', lane.cwd, input.commit]);
      assert.deepEqual(testedInput(lane.cwd, false), input);
      assert.equal(execFileSync(lane.nodePath, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim(), lane.node);
    }
    const results = await Promise.allSettled(lanes.map(lane => run(lane.nodePath, ['scripts/ci-run.mjs', 'prepare', lane.id], lane.cwd,
      { PATH: `${resolve(lane.nodePath, '..')}:/usr/bin:/bin:/usr/sbin:/sbin`, GITHUB_SHA: input.commit, RUNNER_TEMP: join(record, 'jobs') }, join(record, `${lane.id}-prepare.log`))));
    batch.ready = Date.now(); batch.prepareExit = results.every(r => r.status === 'fulfilled') ? 0 : 1;
    writeFileSync(manifestPath, JSON.stringify(batch, null, 2));
    for (const result of results) if (result.status === 'rejected') console.error(result.reason.message);
    assert.equal(batch.prepareExit, 0, 'local setup did not pass');
  } catch (error) { releaseAfter(batch); throw error; }
} else if (action === 'test') {
  const batch = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(batch.prepareExit, 0);
  assert.deepEqual(testedInput(), batch.input, 'parent source changed since prepare');
  const testStarted = Date.now();
  try {
    const results = await Promise.allSettled(batch.lanes.map(lane => run(lane.nodePath, ['scripts/ci-run.mjs', 'test', lane.id], lane.cwd,
      { PATH: `${resolve(lane.nodePath, '..')}:/usr/bin:/bin:/usr/sbin:/sbin`, GITHUB_SHA: batch.input.commit, RUNNER_TEMP: join(record, 'jobs') }, join(record, `${lane.id}-test.log`))));
    for (const result of results) if (result.status === 'rejected') console.error(result.reason.message);
    assert.ok(results.every(r => r.status === 'fulfilled'), 'a local test process failed');
    const receipts = batch.lanes.map(lane => JSON.parse(readFileSync(join(record, 'jobs', `ci-${lane.id}`, 'receipt.json'), 'utf8')));
    assert.ok(receipts.every(r => r.started >= testStarted && r.started >= batch.ready), 'stale receipt from an earlier batch');
    const timing = validateReceipts(batch.lanes, receipts, batch.input.commit);
    assert.ok(receipts.every(r => r.input.tree === batch.input.tree));
    assert.deepEqual(testedInput(), batch.input, 'parent source changed during testing');
    const report = { ...batch.input, ...timing, batchAdmitted: batch.admitted, batchReady: batch.ready,
      finished: Date.now(), exit: 0, receipts };
    writeFileSync(join(record, 'mac-validation.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ commit: report.commit, tree: report.tree, testWindowSeconds: report.testWindowSeconds, exit: 0 }));
  } finally { releaseAfter(batch); }
} else if (action === 'clean') {
  release(JSON.parse(readFileSync(manifestPath, 'utf8')));
} else if (action === 'combine') {
  const mac = JSON.parse(readFileSync(join(record, 'mac-validation.json'), 'utf8'));
  const linux = JSON.parse(readFileSync(resolve(toolchains), 'utf8'));
  const input = testedInput();
  validateReceipts(plan().filter(l => l.os === 'macos-latest'), mac.receipts, mac.commit);
  validateReceipts(plan().filter(l => l.os === 'ubuntu-latest'), linux.lanes.filter(l => l.id !== 'checks'), linux.sha);
  assert.equal(mac.exit, 0); assert.equal(mac.tree, input.tree); assert.equal(linux.tree, input.tree);
  assert.ok([...mac.receipts, ...linux.lanes].every(r => r.input?.tree === input.tree && r.input.dirty === false));
  // Performance is reported separately from correctness.
  const receipts = [...mac.receipts, ...linux.lanes];
  const testWindowSeconds = (Math.max(...receipts.map(r => r.finished)) - Math.min(...receipts.map(r => r.started))) / 1000;
  const report = { ...input, macCommit: mac.commit, linuxCommit: linux.sha, testWindowSeconds,
    testsUnderFiveMinutes: testWindowSeconds <= 300, firstTest: Math.min(...receipts.map(r => r.started)),
    lastTest: Math.max(...receipts.map(r => r.finished)), coldAdmitted: Math.min(mac.batchAdmitted, ...linux.lanes.map(r => r.admitted)),
    evidence: { mac: join(record, 'mac-validation.json'), linux: resolve(toolchains) } };
  writeFileSync(join(record, 'all-platforms.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.testsUnderFiveMinutes) console.warn(`Soft five-minute target exceeded: ${testWindowSeconds.toFixed(1)}s; correctness passed.`);
} else throw new Error('usage: ci-local-mac.mjs prepare|test|clean <private-record-dir> <verified-toolchains-dir>; combine <record-dir> <Linux ci-timing.json>');
