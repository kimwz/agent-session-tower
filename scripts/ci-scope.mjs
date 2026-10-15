/**
 * Decides how much CI a change needs, from the files it touches:
 * - quick: documentation and a patch version bump only. CI runs the checks job; the tests are the base commit's,
 *   which must itself have passed `validation gate (all platforms)`.
 * - related: ordinary features. The Node 22 floor runs the whole inventory once on Linux and once on macOS.
 * - full: storage, permissions, secrets, updates, execution lifetime, build and CI, a minor or major version, and
 *   every path outside the named ordinary areas. All lanes run.
 * Usage: node scripts/ci-scope.mjs plan | local
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

export const TIERS = ['quick', 'related', 'full'];
export const GATE = 'validation gate (all platforms)';
const rank = tier => TIERS.indexOf(tier);
export const atLeast = (tier, floor) => rank(tier) >= rank(floor);

// Only these areas count as ordinary features. Everything else, a new server area included, needs the full run.
const GENERAL_AREAS = ['agent-guidance', 'auto-prompt', 'browser', 'decisions', 'models', 'notifications', 'repositories', 'sessions',
  'skills', 'slack', 'streams', 'triggers'];
const GENERAL = new RegExp(`^(client/|assets/|shared/|tests/(client|shared|gates|release)/|(server|tests/server)/(${GENERAL_AREAS.join('|')})/|(server|tests)/master/(voice|tts|elevenlabs|mp3|first-reply))`);
// Data, access, secrets, updates and process lifetime inside an ordinary area are core all the same, whether a file is
// named after them or imports them.
const SENSITIVE = /(storage|store|state|backup|secret|access|sqlite|retention|migrat|permission|auth|launch|process|lifetime|handoff|worker|^link\.(ts|js)$)/i;
const CORE_MODULE = /(^node:sqlite$|(^|\/)(storage|stores|secrets|permissions|auth|updates|link|backup)(\/|$))/;
const IMPORTS = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
const importsCore = text => [...(text ?? '').matchAll(IMPORTS)].some(([, specifier]) =>
  CORE_MODULE.test(specifier) || SENSITIVE.test(specifier.split('/').pop()));
const BUILD = /^(\.github|scripts|bin)\//;
const DOCS = new Set(['README.md', 'README.ko.md', 'AGENTS.md', 'CLAUDE.md', 'CHANGELOG.md', 'LICENSE', 'assets/brand/README.md']);
const APP_VERSION = /^export const APP_VERSION = '[^'\n]*';$/m;

/**
 * The tier one path needs, given its text before and after (null when absent); the version metadata files are decided
 * by their content in `classify`.
 */
export function pathTier(path, texts = []) {
  if (DOCS.has(path) || path.startsWith('docs/')) return { tier: 'quick' };
  if (BUILD.test(path)) return { tier: 'full', reason: `build or CI: ${path}` };
  if (!GENERAL.test(path) || path.split('/').slice(1).some(part => SENSITIVE.test(part))) return { tier: 'full', reason: `core or unclassified: ${path}` };
  // Access and data are decided by the server; a browser module importing a settings or secrets view is not core.
  if (!path.startsWith('client/') && texts.some(importsCore)) return { tier: 'full', reason: `imports a core module: ${path}` };
  return { tier: 'related', reason: `code: ${path}` };
}

const semver = text => /^(\d+)\.(\d+)\.(\d+)$/.exec(text ?? '')?.slice(1).map(Number);
const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };
const withoutVersion = (text, lock) => {
  const value = parse(text);
  if (!value || typeof value !== 'object') return undefined;
  delete value.version;
  if (lock) delete value.packages?.['']?.version;
  return value;
};

/** Whether a version metadata file changed nothing but its version. A file added or removed is more than that. */
export function versionOnly(path, before, after) {
  if (before == null || after == null) return false;
  if (path === 'shared/app-identity.ts') {
    return [before, after].every(text => (text.match(new RegExp(APP_VERSION.source, 'gm')) ?? []).length === 1)
      && before.replace(APP_VERSION, '') === after.replace(APP_VERSION, '');
  }
  const a = withoutVersion(before, path === 'package-lock.json'), b = withoutVersion(after, path === 'package-lock.json');
  return a !== undefined && b !== undefined && isDeepStrictEqual(a, b);
}

/**
 * `changes` lists every changed path (a rename as its old and new path); `content(path, side)` reads a file at 'base' or
 * 'head', or returns null when it is absent there. `baseGreen` says whether the base commit passed the gate.
 */
export function classify({ changes, content, baseGreen, nextVersion }) {
  let tier = 'quick';
  const reasons = [];
  const raise = (to, reason) => { if (rank(to) > rank(tier)) tier = to; if (reason && !reasons.includes(reason)) reasons.push(reason); };
  for (const path of changes) {
    if (path === 'package.json' || path === 'package-lock.json' || path === 'shared/app-identity.ts') {
      if (!versionOnly(path, content(path, 'base'), content(path, 'head'))) raise('full', `more than the version: ${path}`);
      continue;
    }
    const { tier: needed, reason } = pathTier(path, [content(path, 'base'), content(path, 'head')]);
    raise(needed, reason);
  }
  const from = parse(content('package.json', 'base'))?.version, to = nextVersion ?? parse(content('package.json', 'head'))?.version;
  if (from !== to) {
    const [a, b] = [semver(from), semver(to)];
    if (!a || !b) raise('full', `unreadable version: ${from} → ${to}`);
    else if (a[0] !== b[0] || a[1] !== b[1]) raise('full', `minor or major version: ${from} → ${to}`);
    else if (b[2] <= a[2]) raise('full', `version not raised: ${from} → ${to}`);
  }
  if (tier === 'quick' && baseGreen !== true) raise('full', 'base commit has not passed the gate');
  return { tier, reasons, files: changes, version: { from, to } };
}

/** Whether the newest gate check run of a commit completed with success. Pending, skipped, failed or absent is not. */
export function gatePassed(checkRuns) {
  const gates = checkRuns.filter(run => run.name === GATE && run.app?.slug === 'github-actions');
  if (!gates.length) return { passed: false, reason: 'no gate run (workflow skipped or never started)' };
  const latest = gates.reduce((a, b) => (b.id > a.id ? b : a));
  if (latest.status !== 'completed') return { passed: false, reason: `gate ${latest.status}` };
  if (latest.conclusion !== 'success') return { passed: false, reason: `gate ${latest.conclusion}` };
  return { passed: true, reason: 'gate success', id: latest.id };
}

const gitIn = cwd => (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
const git = gitIn('.');
const gitShowIn = cwd => (rev, path) => { try { return execFileSync('git', ['show', `${rev}:${path}`], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const gitShow = gitShowIn('.');
const gh = args => JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

/** The gate verdict of a commit from GitHub. Any API failure counts as not passed. */
export function commitGate(sha, repo = process.env.GITHUB_REPOSITORY) {
  try {
    const runs = gh(['--paginate', '--slurp', `repos/${repo}/commits/${sha}/check-runs?per_page=100&check_name=${encodeURIComponent(GATE)}`])
      .flatMap(page => page.check_runs);
    return gatePassed(runs);
  } catch (error) { return { passed: false, reason: `cannot read gate: ${error.message.split('\n')[0]}` }; }
}

/**
 * The change a CI run validates: the checked-out commit against its first parent (a pull request's merge ref or a squash
 * merge). `gate` reads the base commit's gate, only for a quick change; pass `() => ({ passed: true })` for paths alone.
 */
export function ciScope({ event = process.env.GITHUB_EVENT_NAME, before = process.env.CI_PUSH_BEFORE, gate = commitGate, cwd = '.' } = {}) {
  const git = gitIn(cwd), show = gitShowIn(cwd);
  const head = git('rev-parse', 'HEAD'), base = git('rev-parse', 'HEAD^1');
  const changes = git('diff', '--no-renames', '--name-only', '-z', base, head).split('\0').filter(Boolean);
  const content = (path, side) => show(side === 'base' ? base : head, path);
  const pathOnly = classify({ changes, content, baseGreen: true });
  const baseGate = pathOnly.tier === 'quick' ? gate(base) : undefined;
  const scope = classify({ changes, content, baseGreen: baseGate ? baseGate.passed : true });
  if (event === 'push' && before !== base) { scope.tier = 'full'; scope.reasons.push(`push of more than one commit (${before} → ${head})`); }
  return { ...scope, event, base, head, tree: git('rev-parse', 'HEAD^{tree}'), baseGate };
}

/**
 * Whether a commit on main may reuse its pull request's result: the newest CI run of the merged pull request's head passed,
 * and its gate record says it validated this very tree at a related or full tier that covers `needed`. The same tree means
 * the same code, lockfile, workflow and tests. `api(path)` returns parsed JSON; `artifact(id)` returns the gate record.
 */
export function reuseEvidence({ head, tree, needed, repo, api, artifact }) {
  try {
    const pr = api(`repos/${repo}/commits/${head}/pulls`).find(item => item.merged_at && item.merge_commit_sha === head);
    if (!pr) return { reused: false, reason: 'no merged pull request with this merge commit' };
    const runs = api(`repos/${repo}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`).workflow_runs;
    const run = runs.reduce((a, b) => (!a || b.run_number > a.run_number || (b.run_number === a.run_number && b.run_attempt > a.run_attempt) ? b : a), undefined);
    if (!run || run.status !== 'completed' || run.conclusion !== 'success') return { reused: false, reason: `pull request CI ${run ? `${run.status}/${run.conclusion}` : 'missing'}` };
    const records = api(`repos/${repo}/actions/runs/${run.id}/artifacts?name=ci-timing&per_page=100`).artifacts.filter(item => !item.expired);
    const newest = records.reduce((a, b) => (!a || b.created_at > a.created_at || (b.created_at === a.created_at && b.id > a.id) ? b : a), undefined);
    if (!newest) return { reused: false, reason: 'pull request gate record missing' };
    const record = artifact(newest.id);
    if (record.verdict !== 'pass') return { reused: false, reason: 'pull request gate record is not a pass' };
    if (record.tree !== tree) return { reused: false, reason: `pull request validated tree ${record.tree}, this commit is ${tree}` };
    if (!['related', 'full'].includes(record.tier) || !atLeast(record.tier, needed)) return { reused: false, reason: `pull request tier ${record.tier} does not cover ${needed}` };
    return { reused: true, reason: `pull request #${pr.number} run ${run.id} validated this tree at ${record.tier}`, pr: pr.number, run: run.id, tier: record.tier };
  } catch (error) { return { reused: false, reason: `cannot read pull request result: ${error.message.split('\n')[0]}` }; }
}

export const ghJson = path => gh([path]);
export const ghArtifact = id => {
  const zip = join(mkdtempSync(join(tmpdir(), 'ci-record-')), 'record.zip');
  writeFileSync(zip, execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`], { maxBuffer: 64 * 1024 * 1024 }));
  return JSON.parse(execFileSync('unzip', ['-p', zip, 'ci-timing.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
};

/** What a CI run checks: its scope, and on main whether it reuses the pull request's result (`execution: 'reuse'`, no lanes). */
export function planCi({ scope = ciScope(), api = ghJson, artifact = ghArtifact, repo = process.env.GITHUB_REPOSITORY } = {}) {
  if (scope.event !== 'push' || scope.tier === 'quick') return { ...scope, execution: 'run', evidence: undefined };
  const evidence = reuseEvidence({ head: scope.head, tree: scope.tree, needed: scope.tier, repo, api, artifact });
  return { ...scope, execution: evidence.reused ? 'reuse' : 'run', evidence };
}

/** Local `npm version` check: the working tree against where it left origin/main. */
export function localScope() {
  const base = git('merge-base', 'HEAD', 'origin/main');
  const changes = [...new Set([...git('diff', '--no-renames', '--name-only', '-z', base).split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0')].filter(Boolean))].sort();
  const content = (path, side) => {
    if (side === 'base') return gitShow(base, path);
    try { return readFileSync(path, 'utf8'); } catch { return null; }
  };
  // `npm version` runs this before it writes the new version, so take the version it is about to write.
  return classify({ changes, content, baseGreen: true, nextVersion: process.env.npm_new_version || undefined });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const action = process.argv[2];
  if (action === 'plan') {
    const { lanesFor } = await import('./ci-plan.mjs');
    const planned = planCi();
    const lanes = planned.execution === 'reuse' ? [] : lanesFor(planned.tier);
    writeFileSync('ci-scope.json', `${JSON.stringify({ ...planned, lanes: lanes.map(lane => lane.id) }, null, 2)}\n`);
    console.log(JSON.stringify(planned, null, 2));
    const matrix = { include: lanes.map(({ id, os, node, shard, kind }) => ({ id, os, node, label: kind === 'compat' ? 'compatibility' : `shard ${shard}` })) };
    appendFileSync(process.env.GITHUB_OUTPUT, `tier=${planned.tier}\nexecution=${planned.execution}\nlanes=${lanes.length}\nmatrix=${JSON.stringify(matrix)}\n`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `CI tier **${planned.tier}** (${planned.execution}), ${lanes.length} lanes. ${[...planned.reasons, planned.evidence?.reason, planned.baseGate?.reason].filter(Boolean).join('; ')}\n`);
  } else if (action === 'local') {
    let scope;
    try { scope = localScope(); } catch (error) { scope = { tier: 'full', reasons: [`cannot classify: ${error.message.split('\n')[0]}`] }; }
    console.error(`Local check: ${scope.tier}${scope.reasons.length ? ` (${scope.reasons.join('; ')})` : ''}`);
    const steps = scope.tier === 'quick' ? [['run', 'typecheck'], ['run', 'test:quick'], ['run', 'build']] : [['run', 'check']];
    for (const args of steps) execFileSync('npm', args, { stdio: 'inherit' });
  } else throw new Error('usage: ci-scope.mjs plan | local');
}
