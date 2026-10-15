import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lanesFor, plan, slowTestReport, validateReceipts } from './ci-plan.mjs';
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
  check(checks?.sha === sha && checks.exit === 0 && checks.quick === true, 'missing checks or quick suite');
  check(receipts.every(receipt => receipt.input?.tree === tree && receipt.input.dirty === false), 'not every job tested the checked-out tree');
  let timing = {};
  try { if (expected.length || receipts.length > 1) timing = validateReceipts(expected, receipts.filter(receipt => receipt.id !== 'checks'), sha); }
  catch (error) { problems.push(error.message); }
  return { problems, timing };
}

/**
 * Rereads what a quick tier or a reuse rests on: the base commit's gate, or the pull request's result at the tier the plan
 * ran, which may be above what the files alone need.
 */
export function rereadClaims({ planned, path, gate = commitGate, reuse = reuseEvidence, repo = process.env.GITHUB_REPOSITORY }) {
  return {
    baseGate: planned?.tier === 'quick' ? gate(path.base) : undefined,
    evidence: planned?.execution === 'reuse'
      ? reuse({ head: path.head, tree: path.tree, needed: planned.tier, repo, api: ghJson, artifact: ghArtifact }) : undefined,
  };
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
  const path = ciScope({ gate: null });
  const { baseGate, evidence } = rereadClaims({ planned, path });
  const sha = process.env.GITHUB_SHA;
  const { problems, timing } = gateVerdict({ needs: JSON.parse(process.env.CI_NEEDS), planned, pathTier: path.tier, baseGate,
    evidence, receipts, sha, tree: path.tree });
  const window = receipts.length ? (Math.max(...receipts.map(r => r.finished)) - Math.min(...receipts.map(r => r.started))) / 1000 : undefined;
  const report = { verdict: problems.length ? 'fail' : 'pass', problems, tier: planned?.tier, execution: planned?.execution, pathTier: path.tier, reasons: path.reasons,
    lanes: planned?.lanes, baseGate, evidence, sha, tree: path.tree, testRunnerSeconds: timing.testRunnerSeconds, testWindowSeconds: window,
    setupEnvelopeSeconds: receipts.length ? (Math.max(...receipts.map(r => r.ready)) - Math.min(...receipts.map(r => r.admitted))) / 1000 : undefined,
    // Tests of a second or more, for finding slow tests; never a reason to fail.
    slowTests: slowTestReport(receipts),
    receipts: receipts.map(({ env, slow, ...receipt }) => receipt) };
  writeFileSync('ci-timing.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.slowTests.length) console.log(`${report.slowTests.length} tests took 1 s or more (slowTests in ci-timing.json; reporting only).`);
  if (problems.length) { console.error(`Gate failed:\n- ${problems.join('\n- ')}`); process.exit(1); }
  // Five minutes is an owner-set soft target. Correctness failures above remain blocking.
  if (window > 300) console.warn(`Soft five-minute target exceeded: ${window.toFixed(1)}s; correctness passed.`);
}
