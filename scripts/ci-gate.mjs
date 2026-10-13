import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { plan, validateReceipts } from './ci-plan.mjs';

const receipts = [];
const walk = path => { for (const name of readdirSync(path, { withFileTypes: true })) {
  const file = join(path, name.name);
  if (name.isDirectory()) walk(file);
  else if (name.name === 'receipt.json') receipts.push(JSON.parse(readFileSync(file, 'utf8')));
} };
walk(process.argv[2]);
const results = JSON.parse(process.env.CI_NEEDS);
assert.ok(Object.values(results).every(job => job.result === 'success'), 'a required job failed/cancelled/skipped');
const checks = receipts.find(r => r.id === 'checks');
assert.ok(checks && checks.sha === process.env.GITHUB_SHA && checks.exit === 0 && checks.legacyNode === '22.13.0', 'missing checks or actual legacy verdict');
const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
assert.ok(receipts.every(r => r.input?.tree === tree && r.input.dirty === false), 'not every lane tested the checked-out tree');
const linux = receipts.filter(r => r.id !== 'checks');
const timing = validateReceipts(plan().filter(l => l.os === 'ubuntu-latest'), linux, process.env.GITHUB_SHA);
timing.testWindowSeconds = (Math.max(...receipts.map(r => r.finished)) - Math.min(...receipts.map(r => r.started))) / 1000;
const report = { scope: 'Linux; owner Mac is a separate actual commit status', sha: process.env.GITHUB_SHA, tree, ...timing, testsUnderFiveMinutes: timing.testWindowSeconds <= 300,
  setupEnvelopeSeconds: (Math.max(...receipts.map(r => r.ready)) - Math.min(...receipts.map(r => r.admitted))) / 1000,
  lanes: receipts.map(({ env, ...r }) => r) };
writeFileSync('ci-timing.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
// Performance failure remains visible; never replace a failed correctness check with a five-minute timeout.
assert.ok(report.testsUnderFiveMinutes, `all-test window ${timing.testWindowSeconds.toFixed(1)}s exceeds 300s`);
