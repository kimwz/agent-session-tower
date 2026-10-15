import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lanesFor, plan, validateReceipts } from './ci-plan.mjs';
import { TIERS, atLeast, ciScope, commitGate, ghArtifact, ghJson, reuseEvidence } from './ci-scope.mjs';

/**
 * The gate's decision, from the jobs' results, the plan's record and the lane receipts. `pathTier` is what the change
 * needs by its files alone, recomputed here; `baseGate` and `evidence` are reread here for a quick tier or a reuse.
 * Every problem is listed; a pass needs none.
 */
export function gateVerdict({ needs, planned, pathTier, baseGate, evidence, receipts, sha, tree, lanes = plan() }) {
  const problems = [];
  const check = (ok, problem) => { if (!ok) problems.push(problem); };
  for (const job of ['plan', 'checks']) check(needs[job]?.result === 'success', `${job} job ${needs[job]?.result ?? 'missing'}`);
  let expected = [];
  const reuse = planned?.execution === 'reuse';
  check(reuse || planned?.execution === 'run', `unknown execution ${planned?.execution}`);
  try { expected = reuse ? [] : lanesFor(planned?.tier, lanes); } catch (error) { problems.push(error.message); }
  check(planned?.head === sha && planned?.tree === tree, 'the plan record is not for this commit');
  check(JSON.stringify(planned?.lanes) === JSON.stringify(expected.map(lane => lane.id)), 'the planned lanes differ from the tier');
  const testResult = needs.test?.result ?? 'missing';
  check(testResult === (expected.length ? 'success' : 'skipped'), `test job ${testResult} with ${expected.length} lanes expected`);
  check(TIERS.includes(planned?.tier) && atLeast(planned.tier, pathTier), `tier ${planned?.tier} is below what the change needs (${pathTier})`);
  if (reuse) check(evidence?.reused === true, `pull request result not reusable: ${evidence?.reason ?? 'unchecked'}`);
  if (planned?.tier === 'quick') check(baseGate?.passed === true, `base commit gate: ${baseGate?.reason ?? 'unchecked'}`);
  const checks = receipts.find(receipt => receipt.id === 'checks');
  check(checks?.sha === sha && checks.exit === 0 && checks.quick === true && checks.legacyNode === '22.13.0',
    'missing checks, quick suite or actual legacy verdict');
  check(receipts.every(receipt => receipt.input?.tree === tree && receipt.input.dirty === false), 'not every job tested the checked-out tree');
  let timing = {};
  try { if (expected.length || receipts.length > 1) timing = validateReceipts(expected, receipts.filter(receipt => receipt.id !== 'checks'), sha); }
  catch (error) { problems.push(error.message); }
  return { problems, timing };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const receipts = [];
  const walk = path => { for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name === 'receipt.json') receipts.push(JSON.parse(readFileSync(file, 'utf8')));
  } };
  const root = process.argv[2];
  walk(root);
  const scopeFile = join(root, 'ci-scope', 'ci-scope.json');
  const planned = existsSync(scopeFile) ? JSON.parse(readFileSync(scopeFile, 'utf8')) : undefined;
  const path = ciScope({ gate: () => ({ passed: true }) });
  const baseGate = planned?.tier === 'quick' ? commitGate(path.base) : undefined;
  // Reread the reused result against the tier the plan ran, which may be above what the files alone need.
  const evidence = planned?.execution === 'reuse'
    ? reuseEvidence({ head: path.head, tree: path.tree, needed: planned.tier, repo: process.env.GITHUB_REPOSITORY, api: ghJson, artifact: ghArtifact }) : undefined;
  const sha = process.env.GITHUB_SHA;
  const { problems, timing } = gateVerdict({ needs: JSON.parse(process.env.CI_NEEDS), planned, pathTier: path.tier, baseGate,
    evidence, receipts, sha, tree: path.tree });
  const window = receipts.length ? (Math.max(...receipts.map(r => r.finished)) - Math.min(...receipts.map(r => r.started))) / 1000 : undefined;
  const report = { verdict: problems.length ? 'fail' : 'pass', problems, tier: planned?.tier, execution: planned?.execution, pathTier: path.tier, reasons: path.reasons,
    lanes: planned?.lanes, baseGate, evidence, scope: 'macOS and Linux', sha, tree: path.tree, ...timing, testWindowSeconds: window,
    setupEnvelopeSeconds: receipts.length ? (Math.max(...receipts.map(r => r.ready)) - Math.min(...receipts.map(r => r.admitted))) / 1000 : undefined,
    receipts: receipts.map(({ env, ...receipt }) => receipt) };
  writeFileSync('ci-timing.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (problems.length) { console.error(`Gate failed:\n- ${problems.join('\n- ')}`); process.exit(1); }
  // Five minutes is an owner-set soft target. Correctness failures above remain blocking.
  if (window > 300) console.warn(`Soft five-minute target exceeded: ${window.toFixed(1)}s; correctness passed.`);
}
